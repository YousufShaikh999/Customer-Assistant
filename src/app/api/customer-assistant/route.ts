import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import mysql from 'mysql2/promise';
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

// Product Interface
interface Product {
  slug: any;
  _id: string;
  title: string;
  price: number;
  inventory: number;
  description: string;
  category?: string;
  image_url?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AssistantResponse {
  reply: string;
  redirect?: string;
  product?: string;
  addToCart?: { id: string; title: string; price: number; image_url?: string };
  history?: ChatMessage[];
  error?: string;
  phase?: 'general' | 'recommendation';
  lastShownProducts?: Product[]; // Track products shown to user
  sessionId?: string;
}

// Add these interfaces at the top of your file
interface ChatSession {
  id: string;
  history: ChatMessage[];
  lastShownProducts?: Product[];
  createdAt: number;
  updatedAt: number;
  timeout?: NodeJS.Timeout;
}

const SESSION_TIMEOUT = 5 * 60 * 1000;
// Simple in-memory store (for production, use Redis or database)
export const sessions = new Map<string, ChatSession>();

// Helper function to get or create session
function getOrCreateSession(sessionId?: string): ChatSession {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.updatedAt = Date.now();
    return session;
  }
  
  // Create new session
  const newSession: ChatSession = {
    id: generateSessionId(),
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  
  sessions.set(newSession.id, newSession);
  return newSession;
}

function generateSessionId(): string {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [id, session] of sessions.entries()) {
    if (now - session.updatedAt > oneHour) {
      sessions.delete(id);
    }
  }
}, 30 * 60 * 1000); // Run every 30 minutes

const requestSchema = z.object({
  query: z.string().min(1).max(500),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional(),
  lastShownProducts: z.array(z.object({
    _id: z.string(),
    title: z.string(),
    price: z.number(),
    inventory: z.number(),
    description: z.string(),
    slug: z.any(),
    category: z.string().optional(),
    image_url: z.string().optional()
  })).optional(),
  sessionId: z.string().nullable().optional()
});

// Enhanced Configuration
interface Config {
  maxHistoryLength: number;
  generalAiModel: "gpt-3.5-turbo";
  recommendationAiModel: "gpt-3.5-turbo";
  baseUrl: string;
  storeName: string;
  semanticKeywords: Record<string, string[]>;
  eventKeywords: Record<string, string[]>;
  fallbackResponses: string[];
  nonsenseResponses: string[];
  timeoutMs: number;
  clarifyingQuestions: string[];
  comparisonAiModel: "gpt-3.5-turbo";
  comparisonKeywords: string[];
  vagueProductQuestions: string[];
}

const config: Config = {
  maxHistoryLength: 10,
  generalAiModel: "gpt-3.5-turbo",
  recommendationAiModel: "gpt-3.5-turbo",
  baseUrl: "http://plugin.ijkstaging.com",
  storeName: process.env.STORE_NAME || "Plugin Store",
  timeoutMs: 5000, // 5 second timeout for responses
  comparisonAiModel: "gpt-3.5-turbo",
  comparisonKeywords: [
    'compare', 'comparison', 'vs', 'versus', 'difference between',
    'differences between', 'which is better', 'pros and cons',
    'should I get', 'help me choose', 'which one', 'versus',
    'better option', 'advantages of', 'contrast between'
  ],
  vagueProductQuestions: [
    "I'd be happy to show you products! Could you please specify what type of product you're looking for? For example: card printers, projectors, electronics, or something specific?",
    "Sure! To help you better, could you tell me what kind of product you need? We have card printers, projectors, electronics, and more.",
    "I can show you products, but it would help if you could be more specific. What type of product are you interested in buying?",
    "Of course! What specific product category are you looking for? We specialize in card printers, projectors, and various electronics.",
    "I'd love to help you find products! Could you please tell me what you're shopping for today? Any specific category or product name?",
    "Absolutely! To show you the most relevant products, could you specify what you're looking for? For example: printers, electronics, or any particular item?",
    "Happy to help! What kind of products are you interested in? Please give me a category or specific product name so I can show you the best options."
  ],

  clarifyingQuestions: [
    "What type of products are you interested in? We have {categories}.",
    "Could you tell me more about what you're looking for? For example, are you interested in {sample_products}?",
    "I'd be happy to help you find products. What category are you interested in? We have {categories}.",
    "What specifically are you looking for today? We offer products like {sample_products}."
  ],

  // Semantic keyword mapping for better product matching
  semanticKeywords: {
    // Electronics & Printers
    'printer': ['printer', 'card printer', 'id printer', 'badge printer', 'printing machine'],
    'cards': ['card', 'id card', 'badge', 'access card', 'employee card'],
    'electronics': ['electronic', 'device', 'machine', 'equipment'],
    'mobile': ['mobile', 'phone', 'smartphone', 'cell phone', 'cellular', 'iphone', 'android', 'samsung', 'huawei', 'xiaomi', 'oppo', 'vivo', 'oneplus'],
    'phone': ['phone', 'mobile', 'smartphone', 'cell phone', 'telephonae'],
    'smartphone': ['smartphone', 'smart phone', 'mobile', 'phone', 'android', 'ios'],

    // Electronics & Computing
    'laptop': ['laptop', 'notebook', 'computer', 'pc', 'macbook', 'chromebook', 'ultrabook'],
    'computer': ['computer', 'pc', 'desktop', 'workstation', 'cpu', 'tower'],
    'tablet': ['tablet', 'ipad', 'android tablet', 'tab', 'slate'],
    'monitor': ['monitor', 'screen', 'display', 'lcd', 'led', 'oled', 'gaming monitor'],
    'keyboard': ['keyboard', 'mechanical keyboard', 'wireless keyboard', 'gaming keyboard'],
    'mouse': ['mouse', 'wireless mouse', 'gaming mouse', 'trackball', 'pointer'],

    'card_printer': ['card printer', 'id card printer', 'badge printer', 'plastic card printer', 'pvc card printer'],
    'projector': ['projector', 'video projector', 'presentation projector', 'digital projector', 'lcd projector', 'led projector'],
    'id_card': ['id card', 'identity card', 'employee card', 'access card', 'badge', 'card'],
    'badge': ['badge', 'id badge', 'employee badge', 'name badge', 'access badge'],

    // Audio & Video
    'headphones': ['headphones', 'headset', 'earphones', 'earbuds', 'wireless headphones', 'bluetooth headphones'],
    'speaker': ['speaker', 'bluetooth speaker', 'wireless speaker', 'portable speaker', 'stereo'],
    'microphone': ['microphone', 'mic', 'recording mic', 'usb mic', 'wireless mic'],
    'camera': ['camera', 'digital camera', 'webcam', 'video camera', 'dslr', 'mirrorless'],

    // Gaming
    'gaming': ['gaming', 'game', 'console', 'playstation', 'xbox', 'nintendo', 'pc gaming'],
    'controller': ['controller', 'gamepad', 'joystick', 'gaming controller'],

    // Furniture & Home
    'chair': ['chair', 'office chair', 'gaming chair', 'desk chair', 'ergonomic chair', 'stool', 'seat'],
    'table': ['table', 'desk', 'office desk', 'dining table', 'coffee table', 'work table'],
    'desk': ['desk', 'office desk', 'computer desk', 'study desk', 'work desk', 'table'],
    'sofa': ['sofa', 'couch', 'settee', 'loveseat', 'sectional'],
    'bed': ['bed', 'mattress', 'bed frame', 'single bed', 'double bed', 'queen bed', 'king bed'],

    // Storage & Organization
    'cabinet': ['cabinet', 'cupboard', 'storage cabinet', 'file cabinet', 'wardrobe'],
    'shelf': ['shelf', 'bookshelf', 'storage shelf', 'wall shelf', 'shelving unit'],
    'drawer': ['drawer', 'chest of drawers', 'storage drawer', 'filing drawer'],

    // Kitchen & Appliances
    'refrigerator': ['refrigerator', 'fridge', 'freezer', 'cooler', 'ice box'],
    'microwave': ['microwave', 'microwave oven', 'convection microwave'],
    'oven': ['oven', 'baking oven', 'convection oven', 'toaster oven'],
    'blender': ['blender', 'mixer', 'food processor', 'smoothie maker'],
    'toaster': ['toaster', 'bread toaster', 'pop-up toaster'],

    // Lighting
    'lamp': ['lamp', 'table lamp', 'floor lamp', 'desk lamp', 'reading lamp', 'led lamp'],
    'light': ['light', 'lighting', 'led light', 'ceiling light', 'wall light', 'bulb'],
    'bulb': ['bulb', 'light bulb', 'led bulb', 'incandescent bulb', 'cfl bulb'],

    // Clothing & Fashion
    'shirt': ['shirt', 't-shirt', 'tshirt', 'polo shirt', 'dress shirt', 'casual shirt'],
    'pants': ['pants', 'trousers', 'jeans', 'chinos', 'slacks'],
    'shoes': ['shoes', 'sneakers', 'boots', 'sandals', 'heels', 'flats', 'footwear'],
    'jacket': ['jacket', 'coat', 'blazer', 'hoodie', 'cardigan'],
    'dress': ['dress', 'gown', 'frock', 'maxi dress', 'mini dress'],

    // Accessories
    'bag': ['bag', 'handbag', 'backpack', 'purse', 'tote bag', 'shoulder bag', 'laptop bag'],
    'watch': ['watch', 'wristwatch', 'smartwatch', 'digital watch', 'analog watch'],
    'wallet': ['wallet', 'purse', 'money clip', 'card holder'],
    'belt': ['belt', 'leather belt', 'fabric belt'],
    'sunglasses': ['sunglasses', 'shades', 'eyewear', 'sun glasses'],

    // Sports & Fitness
    'bicycle': ['bicycle', 'bike', 'cycle', 'mountain bike', 'road bike', 'hybrid bike'],
    'treadmill': ['treadmill', 'running machine', 'exercise machine'],
    'dumbbell': ['dumbbell', 'weight', 'free weight', 'hand weight'],
    'yoga_mat': ['yoga mat', 'exercise mat', 'fitness mat', 'workout mat'],

    // Books & Education
    'book': ['book', 'textbook', 'novel', 'ebook', 'paperback', 'hardcover'],
    'notebook': ['notebook', 'notepad', 'journal', 'diary', 'writing pad'],
    'pen': ['pen', 'ballpoint pen', 'gel pen', 'fountain pen', 'marker'],
    'pencil': ['pencil', 'mechanical pencil', 'colored pencil', 'drawing pencil'],

    // Tools & Hardware
    'drill': ['drill', 'power drill', 'cordless drill', 'electric drill'],
    'hammer': ['hammer', 'claw hammer', 'sledgehammer', 'mallet'],
    'screwdriver': ['screwdriver', 'phillips screwdriver', 'flathead screwdriver'],
    'wrench': ['wrench', 'spanner', 'adjustable wrench', 'socket wrench'],

    // Beauty & Personal Care
    'perfume': ['perfume', 'cologne', 'fragrance', 'eau de toilette', 'eau de parfum'],
    'shampoo': ['shampoo', 'hair wash', 'hair shampoo', 'anti-dandruff shampoo'],
    'soap': ['soap', 'body soap', 'hand soap', 'bath soap', 'liquid soap'],
    'toothbrush': ['toothbrush', 'electric toothbrush', 'manual toothbrush'],

    // Medical & Health
    'thermometer': ['thermometer', 'digital thermometer', 'infrared thermometer'],
    'medicine': ['medicine', 'medication', 'pills', 'tablets', 'capsules'],
    'first_aid': ['first aid', 'first aid kit', 'medical kit', 'bandage', 'antiseptic'],

    // Toys & Games
    'toy': ['toy', 'kids toy', 'children toy', 'educational toy', 'action figure'],
    'puzzle': ['puzzle', 'jigsaw puzzle', 'brain teaser', 'word puzzle'],
    'board_game': ['board game', 'card game', 'family game', 'strategy game'],

    // Automotive
    'car': ['car', 'vehicle', 'automobile', 'sedan', 'suv', 'hatchback'],
    'tire': ['tire', 'tyre', 'wheel', 'car tire', 'bicycle tire'],
    'battery': ['battery', 'car battery', 'rechargeable battery', 'alkaline battery'],

    // Travel & Luggage
    'suitcase': ['suitcase', 'luggage', 'travel bag', 'carry-on', 'checked bag'],
    'backpack': ['backpack', 'rucksack', 'hiking bag', 'school bag', 'travel backpack'],

    // Furniture & Home
    'seating': ['chair', 'stool', 'bench', 'sofa', 'couch', 'armchair', 'ottoman'],
    'tables': ['table', 'desk', 'dining table', 'coffee table', 'side table', 'nightstand'],
    'storage': ['cabinet', 'drawer', 'shelf', 'bookshelf', 'wardrobe', 'closet', 'chest'],
    'lighting': ['lamp', 'light', 'chandelier', 'bulb', 'fixture', 'sconce'],
    'bedding': ['bed', 'mattress', 'pillow', 'sheet', 'blanket', 'comforter', 'duvet'],

    // Decoration & Party
    'party_decor': ['balloon', 'streamer', 'banner', 'confetti', 'garland', 'backdrop'],
    'lighting_decor': ['candle', 'fairy lights', 'string lights', 'lantern', 'torch'],
    'tableware': ['plate', 'cup', 'glass', 'napkin', 'tablecloth', 'cutlery'],
    'flowers': ['flower', 'bouquet', 'vase', 'plant', 'centerpiece'],

    // Kitchen & Dining
    'cookware': ['pan', 'pot', 'skillet', 'wok', 'bakeware', 'cookware'],
    'appliances': ['blender', 'mixer', 'toaster', 'microwave', 'oven', 'refrigerator'],
    'utensils': ['spoon', 'fork', 'knife', 'spatula', 'whisk', 'tongs'],

    // Audio & Computing
    'audio': ['speaker', 'headphone', 'microphone', 'stereo', 'radio'],
    'computing': ['laptop', 'computer', 'tablet', 'phone', 'monitor', 'keyboard'],

    // Clothing & Accessories
    'clothing': ['shirt', 'pants', 'dress', 'jacket', 'shoes', 'hat'],
    'accessories': ['bag', 'wallet', 'belt', 'watch', 'jewelry', 'sunglasses'],

    // Sports & Fitness
    'fitness': ['weight', 'dumbbell', 'treadmill', 'yoga mat', 'exercise bike'],
    'outdoor': ['tent', 'sleeping bag', 'backpack', 'hiking boots'],

    // Beauty & Personal Care
    'skincare': ['cream', 'lotion', 'serum', 'cleanser', 'moisturizer'],
    'makeup': ['lipstick', 'foundation', 'mascara', 'eyeshadow', 'blush'],

    // Tools & Hardware
    'tools': ['hammer', 'screwdriver', 'drill', 'wrench', 'saw'],
    'hardware': ['screw', 'nail', 'bolt', 'wire', 'cable']
  },

  // Event-based keyword mapping
  eventKeywords: {
    'birthday': ['balloon', 'candle', 'cake', 'party hat', 'banner', 'streamer', 'confetti', 'gift wrap', 'decoration'],
    'wedding': ['flower', 'candle', 'vase', 'tablecloth', 'centerpiece', 'decoration', 'lighting', 'chair cover'],
    'christmas': ['tree', 'ornament', 'light', 'garland', 'wreath', 'decoration', 'candle'],
    'halloween': ['pumpkin', 'decoration', 'candle', 'light', 'costume', 'mask'],
    'thanksgiving': ['candle', 'centerpiece', 'tablecloth', 'decoration', 'turkey', 'fall decoration'],
    'valentine': ['flower', 'candle', 'chocolate', 'gift', 'heart decoration', 'romantic lighting'],
    'baby_shower': ['balloon', 'decoration', 'cake', 'gift', 'banner', 'centerpiece'],
    'graduation': ['balloon', 'banner', 'decoration', 'cap', 'gift', 'party supplies'],
    'new_year': ['light', 'decoration', 'balloon', 'confetti', 'party supplies', 'champagne glass'],
    'easter': ['decoration', 'basket', 'egg', 'bunny', 'spring decoration', 'flower'],
    'housewarming': ['plant', 'candle', 'decoration', 'furniture', 'home decor', 'kitchen items']
  },

  // Fallback responses for when we don't understand
  fallbackResponses: [
    "I'm not quite sure I understand. Could you rephrase that or tell me more about what you're looking for?",
    "I want to help you with that. Could you provide more details about what you need?",
    "I'm still learning! Could you try asking that in a different way?",
    "Let me connect you with a human agent who can better assist with that request.",
    "I'm not certain about that. Would you like me to show you our available products instead?",
    "That's an interesting question! Could you clarify what you're looking for?",
    "I might need more context to help with that. What specifically are you interested in?",
    "I'm here to help with product questions. Could you tell me what you're shopping for today?"
  ],

  // Responses for nonsense queries
  nonsenseResponses: [
    "I'm here to help with your shopping needs! What products are you interested in today?",
    "Let me know how I can assist with finding products in our store!",
    "I'd be happy to help you find what you're looking for in our store.",
    "Looking for something specific? I can help you find it!",
    "I'm your shopping assistant. How can I help with your purchase today?",
    "Let's focus on finding you the perfect product. What are you shopping for?",
    "I'm here to help with your shopping questions. What can I assist you with today?"
  ]
};

interface ConversationContext {
  pendingPurchase?: {
    productId: string;
    productTitle: string;
    productPrice: number;
    productSlug: string;
  };
  pendingAction?: 'buy' | 'view' | 'cart';
  lastRecommendedProducts?: Product[];
  lastShownProducts?: Product[]; // Track products shown in last response
}

// Improved context extraction from history with better purchase detection
function extractContextFromHistory(history: ChatMessage[], lastShownProducts?: Product[]): ConversationContext {
  const context: ConversationContext = {
    lastShownProducts: lastShownProducts || []
  };

  if (!history || history.length < 2) {
    return context;
  }

  // Look at the last assistant message for pending purchase confirmation
  const lastAssistantMessage = history[history.length - 1];

  if (lastAssistantMessage.role === 'assistant') {
    // Better purchase confirmation pattern matching
    const purchaseMatch = lastAssistantMessage.content.match(
      /Would you like to proceed with purchasing (.+?) for (.+?)\?/i
    );

    if (purchaseMatch) {
      const productTitle = purchaseMatch[1].trim();
      const priceText = purchaseMatch[2].trim();
      const productPrice = parseFloat(priceText.replace(/[\$,]/g, ''));

      // Try to find the product in lastShownProducts to get the correct ID and slug
      const matchingProduct = lastShownProducts?.find(p => p.title === productTitle);

      context.pendingPurchase = {
        productId: matchingProduct?._id || '',
        productTitle,
        productPrice,
        productSlug: matchingProduct?.slug || ''
      };
      context.pendingAction = 'buy';
    }

    // Check for view confirmation pattern
    const viewMatch = lastAssistantMessage.content.match(
      /Would you like to view details for (.+?)\?/i
    );
    if (viewMatch) {
      context.pendingAction = 'view';
    }

    // Check for cart confirmation pattern
    const cartMatch = lastAssistantMessage.content.match(
      /Would you like to add (.+?) \((.+?)\) to your cart\?/i
    );
    if (cartMatch) {
      context.pendingAction = 'cart';
    }
  }

  return context;
}

// Enhanced confirmation response detection
function isConfirmationResponse(query: string): 'yes' | 'no' | null {
  const lowerQuery = query.toLowerCase().trim();

  // Positive confirmations
  const yesPatterns = [
    /^yes$/i,
    /^yeah$/i,
    /^yep$/i,
    /^sure$/i,
    /^ok$/i,
    /^okay$/i,
    /^y$/i,
    /^proceed$/i,
    /^go ahead$/i,
    /^continue$/i,
    /^confirm$/i,
    /^yes please$/i,
    /^yes,? proceed$/i,
    /^yes,? continue$/i,
    /^absolutely$/i,
    /^definitely$/i,
    /^of course$/i,
    /^do it$/i,
    /^let's do it$/i,
    /^let's go$/i
  ];

  // Negative confirmations
  const noPatterns = [
    /^no$/i,
    /^nope$/i,
    /^nah$/i,
    /^cancel$/i,
    /^stop$/i,
    /^abort$/i,
    /^n$/i,
    /^no thanks$/i,
    /^not now$/i,
    /^maybe later$/i,
    /^not really$/i,
    /^don't$/i,
    /^skip$/i,
    /^never mind$/i,
    /^forget it$/i
  ];

  if (yesPatterns.some(pattern => pattern.test(lowerQuery))) {
    return 'yes';
  }

  if (noPatterns.some(pattern => pattern.test(lowerQuery))) {
    return 'no';
  }

  return null;
}   Math.random().toString(36).substring(2, 15);


// Enhanced Phase Detection - prioritize confirmation responses
function detectPhase(query: string, history: ChatMessage[], context: ConversationContext): 'general' | 'recommendation' | 'comparison' {
  const lowerQuery = query.toLowerCase().trim();

  // Check for pending actions first
  if (context.pendingAction && isConfirmationResponse(query)) {
    return 'recommendation';
  }

  // Check for comparison queries
  if (isComparisonQuery(query)) {
    return 'comparison';
  }
  // Check for empty or nonsense queries
  if (!lowerQuery || lowerQuery.length < 2 || isNonsenseQuery(lowerQuery)) {
    return 'general';
  }

  // Check for comparison queries FIRST before other patterns

  // Greetings and general questions
  const generalKeywords = [
    'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening',
    'who are you', 'what is this', 'about', 'help me', 'what can you do',
    'introduction', 'welcome', 'greetings', 'what is your name',
    'how are you', 'nice to meet you', 'thank you', 'thanks', 'bye',
    'goodbye', 'help', 'support', 'contact', 'speak to human'
  ];

  // Store-related general questions
  const storeGeneralKeywords = [
    'what do you sell', 'what products do you have', 'tell me about your store',
    'what kind of store is this', 'what services do you offer', 'hours',
    'open', 'close', 'location', 'where are you', 'policy', 'return',
    'shipping', 'delivery', 'payment', 'price match', 'discount'
  ];

  // Check for exact greetings or general questions
  if (generalKeywords.some(keyword => lowerQuery.includes(keyword))) {
    return 'general';
  }

  // Store general questions that should get quick answers
  if (storeGeneralKeywords.some(keyword => lowerQuery.includes(keyword))) {
    return 'general';
  }

  // Recommendation keywords without product names
  const recommendationKeywords = [
    'recommend', 'suggest', 'show me', 'looking for', 'options', 'have any', 'is there any', 'find me', 'search for', 'there any', 'here any'
  ];

  if (recommendationKeywords.some(keyword => lowerQuery.includes(keyword))) {
    return 'recommendation';
  }



  // Check if it's a recommendation keyword without a product name
  const isRecommendationWithoutProduct = recommendationKeywords.some(keyword =>
    lowerQuery.includes(keyword) &&
    !extractProductKeywords(query).length
  );

  if (isRecommendationWithoutProduct) {
    return 'recommendation';

  }

  if (isComparisonQuery(query)) {
    return 'comparison';
  }

  // If it's just a product name, stay in general phase
  const productKeywords = extractProductKeywords(query);
  if (productKeywords.length > 0 && !isRecommendationQuery(query)) {
    return 'general';
  }

  // Everything else goes to general phase by default
  return 'general';
}

function manageConversationHistory(history: ChatMessage[] = [], newUserMessage: string, newAssistantMessage?: string): ChatMessage[] {
  // Start with existing history or empty array
  let updatedHistory = [...history];

  // Add the new user message
  updatedHistory.push({ role: 'user', content: newUserMessage });

  // If there's a new assistant message, add it
  if (newAssistantMessage) {
    updatedHistory.push({ role: 'assistant', content: newAssistantMessage });
  }

  // Limit the history to last 5-6 exchanges (10-12 messages)
  // Each exchange is user + assistant message pair
  const maxLength = 12; // 6 exchanges * 2 messages each
  if (updatedHistory.length > maxLength) {
    updatedHistory = updatedHistory.slice(updatedHistory.length - maxLength);
  }

  return updatedHistory;
}


function isMobileDevice(req: NextRequest): boolean {
  const userAgent = req.headers.get('user-agent') || '';
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
}

// Detect nonsense queries (random characters, repeated letters, etc.)
function isNonsenseQuery(query: string): boolean {
  // Check for repeated characters (like "aaaaaa")
  if (/([a-zA-Z])\1{4,}/.test(query)) return true;

  // Check for random character strings without vowels
  if (!/[aeiouyAEIOUY]/.test(query) && query.length > 6) return true;

  // Check for queries that are too short to be meaningful
  if (query.split(/\s+/).length === 1 && query.length < 3) return true;

  // Check for queries that are just numbers
  if (/^\d+$/.test(query)) return true;

  return false;
}

function findBestProductMatch(productName: string, products: Product[]): Product | null {
  const lowerProductName = productName.toLowerCase();

  // First try exact title match
  let bestMatch = products.find(p =>
    p.title.toLowerCase().includes(lowerProductName) ||
    lowerProductName.includes(p.title.toLowerCase())
  );

  if (bestMatch) return bestMatch;

  // Try partial word matching
  const productWords = lowerProductName.split(/\s+/).filter(word => word.length > 2);

  const scoredProducts: Array<{ product: Product; score: number }> = [];

  products.forEach(product => {
    const productText = `${product.title} ${product.description || ''}`.toLowerCase();
    let score = 0;

    productWords.forEach(word => {
      if (productText.includes(word)) {
        score += word.length; // Longer words get higher scores
      }
    });

    if (score > 0) {
      scoredProducts.push({ product, score });
    }
  });

  // Return the highest scoring match
  if (scoredProducts.length > 0) {
    scoredProducts.sort((a, b) => b.score - a.score);
    return scoredProducts[0].product;
  }

  return null;
}

function generateClarifyingQuestion(products: Product[]): string {
  // Extract unique categories
  const categories = [...new Set(products
    .map(p => p.category)
    .filter(Boolean)
    .flatMap(c => c?.split(', ') || [])
  )];

  // Get some sample product names
  const sampleProducts = [...products]
    .sort(() => 0.5 - Math.random())
    .slice(0, 3)
    .map(p => p.title);

  // Select a random question template
  const template = config.clarifyingQuestions[
    Math.floor(Math.random() * config.clarifyingQuestions.length)
  ];

  // Replace placeholders
  return template
    .replace('{categories}', categories.slice(0, 3).join(', ') + (categories.length > 3 ? ' and more' : ''))
    .replace('{sample_products}', sampleProducts.join(', '));
}

// Enhanced direct action detection
function isDirectActionRequest(query: string, products: Product[]): {
  action: 'buy' | 'view' | 'cart' | null;
  productName: string;
  vague: boolean;
  product?: Product;
} {
  const lowerQuery = query.toLowerCase().trim();

  // Vague buy requests (without product name)
  if (/^(buy|purchase|get|order)\s*(it|this|that|one|something)?$/i.test(lowerQuery)) {
    return { action: 'buy', productName: '', vague: true };
  }

  // Vague view requests
  if (/^(view)$/i.test(lowerQuery)) {
    return { action: 'view', productName: '', vague: true };
  }

  // Vague cart requests
  if (/^(add to cart|cart|add|put in cart)\s*(it|this|that|one)?$/i.test(lowerQuery)) {
    return { action: 'cart', productName: '', vague: true };
  }

  // Specific buy requests (with product name)
  if (/(buy|purchase|get|order)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(buy|purchase|get|order)\s+(.+)/i);
    const productName = match?.[2] || '';
    if (!['it', 'this', 'that', 'one'].includes(productName.trim().toLowerCase())) {
      const matchingProducts = findMatchingProducts(productName, products);
      return {
        action: 'buy',
        productName,
        vague: false,
        product: matchingProducts[0] || undefined
      };
    }
  }

  // Similar for view and cart...
  return { action: null, productName: '', vague: false };
}

// Improved price range detection
function detectPriceRange(query: string): { min?: number; max?: number } | null {
  const lowerQuery = query.toLowerCase();

  // Under/below patterns
  const underPattern = /(under|below|less than|up to|maximum|max|cheaper than)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const underMatch = lowerQuery.match(underPattern);

  // Over/above patterns  
  const overPattern = /(over|above|more than|greater than|minimum|min|at least|expensive than)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const overMatch = lowerQuery.match(overPattern);

  // Between range patterns
  const betweenPattern = /(between|from)\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:and|to|-|and up to)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const betweenMatch = lowerQuery.match(betweenPattern);

  // Around/approximately patterns
  const aroundPattern = /(around|approximately|about|near|close to)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const aroundMatch = lowerQuery.match(aroundPattern);

  // Exact price
  const exactPattern = /(\$?\s*\d+(?:\.\d{1,2})?)\s*(exactly|precisely)/i;
  const exactMatch = lowerQuery.match(exactPattern);

  if (betweenMatch) {
    const min = parseFloat(betweenMatch[2]);
    const max = parseFloat(betweenMatch[3]);
    return { min: Math.min(min, max), max: Math.max(min, max) };
  } else if (underMatch) {
    return { max: parseFloat(underMatch[2]) };
  } else if (overMatch) {
    return { min: parseFloat(overMatch[2]) };
  } else if (aroundMatch) {
    const price = parseFloat(aroundMatch[2]);
    return { min: price * 0.8, max: price * 1.2 }; // 20% range around the price
  } else if (exactMatch) {
    const price = parseFloat(exactMatch[1].replace('$', ''));
    return { min: price * 0.95, max: price * 1.05 }; // Tight 5% range for exact matches
  }

  return null;
}

function extractProductSuggestionFromQuery(query: string): string {
  const lowerQuery = query.toLowerCase().trim();

  // Remove common question words and filler words
  const fillerWords = [
    'do', 'you', 'have', 'any', 'what', 'about', 'tell', 'me', 'show', 'is', 'there',
    'are', 'can', 'could', 'would', 'should', 'i', 'need', 'want', 'looking', 'for',
    'the', 'a', 'an', 'some', 'of', 'in', 'on', 'at', 'by', 'with', 'product', 'item', 'thing', 'stuff', 'things', 'items', 'products'
  ];

  // Split query into words and remove filler words
  const words = lowerQuery.split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.includes(word))
    .filter((word, index, self) => self.indexOf(word) === index); // Remove duplicates

  // Return the cleaned query or the most meaningful part
  if (words.length === 0) {
    return lowerQuery;
  }

  return words.join(' ');
}

// Enhanced comparison detection
function isComparisonQuery(query: string): { product1: string; product2: string } | null {
  const lowerQuery = query.toLowerCase().trim();

  const hasComparisonKeyword = config.comparisonKeywords.some(keyword =>
    lowerQuery.includes(keyword.toLowerCase())
  );

  if (!hasComparisonKeyword) {
    return null;
  }

  // Enhanced patterns for comparison questions - more flexible matching
  const patterns = [
  // "difference between X and Y" or "difference b/w X and Y"
  /(?:what(?:'s| is| are)? (?:the )?)?difference(?:s)? (?:between|b\\w) (?:a |an |the )?(.+?) (?:and|or|vs\.?|versus) (?:a |an |the )?(.+?)(?:\?|$)/i,

  // "compare X and Y" or "comparison between X and Y" or "comparison b/w X and Y"
  /(?:compare|comparison)(?: between| b\\w)? (?:a |an |the )?(.+?) (?:and|or|vs\.?|versus) (?:a |an |the )?(.+?)(?:\?|$)/i,

  // "X vs Y" or "X versus Y"
  /(.+?) (?:vs\.?|versus) (.+?)(?:\?|$)/i,

  // "which is better X or Y"
  /(?:which is better|which one is better|what's better)(?: between| b\\w)? (?:a |an |the )?(.+?) (?:or|vs\.?|versus) (?:a |an |the )?(.+?)(?:\?|$)/i,

  // "should i get X or Y"
  /(?:should i get|should i buy|would you recommend)(?: a| an| the)? (.+?) (?:or|vs\.?|versus) (?:a |an |the )?(.+?)(?:\?|$)/i,

  // Flexible: "what is the difference of X and Y" or "comparison b/w X and Y"
  /(?:what(?:'s| is)?|tell me) (?:about )?(?:the )?(?:difference|comparison) (?:of |between |b\\w )?(?:a |an |the )?(.+?) (?:and|or|vs\.?|versus) (?:a |an |the )?(.+?)(?:\?|$)/i,

  // "help me choose between X and Y" or "choose b/w X and Y"
  /(?:help me choose (?:between|b\\w)|choose (?:between|b\\w)) (?:a |an |the )?(.+?) (?:and|or|vs\.?|versus) (?:a |an |the )?(.+?)(?:\?|$)/i,

  // "pros and cons of X vs Y" or "advantages of X compared to Y"
  /(?:pros and cons of|advantages of) (.+?) (?:vs\.?|versus|compared to) (.+?)(?:\?|$)/i
];


  for (const pattern of patterns) {
    const match = lowerQuery.match(pattern);
    if (match && match[1] && match[2]) {
      // Clean up the product names
      const product1 = match[1].trim().replace(/^(a |an |the )/i, '');
      const product2 = match[2].trim().replace(/^(a |an |the )/i, '');

      // Make sure both products have meaningful names (at least 2 characters)
      if (product1.length > 1 && product2.length > 1) {
        return { product1, product2 };
      }
    }
  }

  return null;
}

// Extract product keywords from query (excluding price-related words)
function extractProductKeywords(query: string): string[] {
  const lowerQuery = query.toLowerCase();

  // Remove price-related phrases
  const pricePatterns = [
    /(under|below|less than|up to|maximum|max)\s*\$?\s*\d+(?:\.\d{1,2})?/gi,
    /(over|above|more than|greater than|minimum|min)\s*\$?\s*\d+(?:\.\d{1,2})?/gi,
    /between\s*\$?\s*\d+(?:\.\d{1,2})?\s*(?:and|to|-)\s*\$?\s*\d+(?:\.\d{1,2})?/gi,
    /(around|approximately|about)\s*\$?\s*\d+(?:\.\d{1,2})?/gi,
    /\$\d+(?:\.\d{1,2})?/gi
  ];

  let cleanQuery = lowerQuery;
  pricePatterns.forEach(pattern => {
    cleanQuery = cleanQuery.replace(pattern, '');
  });

  // Remove common filler words and question words
  const fillerWords = [
    'is', 'there', 'any', 'do', 'you', 'have', 'show', 'me', 'some', 'find',
    'looking', 'for', 'need', 'want', 'what', 'where', 'when', 'how', 'why',
    'can', 'could', 'would', 'should', 'does', 'did', 'are', 'am', 'the', 'a',
    'an', 'that', 'this', 'those', 'these', 'please', 'thank', 'thanks', 'hi',
    'hello', 'hey', 'greetings', 'about', 'with', 'without', 'like', 'similar',
    'to', 'from', 'of', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'but'
  ];

  // Extract meaningful product-related words
  const words = cleanQuery.split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.includes(word))
    .filter((word, index, self) => self.indexOf(word) === index); // Remove duplicates

  return words;
}

// Smart product matching function with improved price filtering
function findMatchingProducts(query: string, products: Product[]): Product[] {
  const lowerQuery = query.toLowerCase();
  const priceRange = detectPriceRange(query);
  const productKeywords = extractProductKeywords(query);

  // Step 1: Filter by price if specified
  let filteredProducts = products;
  if (priceRange) {
    filteredProducts = products.filter(product => {
      const price = product.price;
      if (priceRange.min !== undefined && priceRange.max !== undefined) {
        return price >= priceRange.min && price <= priceRange.max;
      } else if (priceRange.min !== undefined) {
        return price > priceRange.min;
      } else if (priceRange.max !== undefined) {
        return price <= priceRange.max;
      }
      return true;
    });
  }

  // If no product keywords, return empty array (don't show random products)
  if (productKeywords.length === 0) {
    return [];
  }

  // Step 2: Apply strict product keyword matching
  const matchedProducts: Product[] = [];

  filteredProducts.forEach(product => {
    const productText = `${product.title} ${product.description || ''} ${product.category || ''}`.toLowerCase();

    // Check for exact match in product title first
    const hasExactMatch = productKeywords.some(keyword =>
      product.title.toLowerCase().includes(keyword)
    );

    if (hasExactMatch) {
      matchedProducts.push(product);
      return;
    }

    // Then check semantic matching
    let semanticMatch = false;
    for (const [category, keywords] of Object.entries(config.semanticKeywords)) {
      // Check if query keyword matches any semantic category
      const hasQueryKeyword = productKeywords.some(qkw =>
        keywords.includes(qkw)
      );

      // Check if product matches any keyword in this category
      const hasProductKeyword = keywords.some(keyword =>
        productText.includes(keyword)
      );

      if (hasQueryKeyword && hasProductKeyword) {
        semanticMatch = true;
        break;
      }
    }

    if (semanticMatch) {
      matchedProducts.push(product);
    }
  });

  // Return matched products sorted by relevance (exact matches first)
  return matchedProducts.sort((a, b) => {
    // Score based on exact matches in title
    const aScore = productKeywords.filter(kw =>
      a.title.toLowerCase().includes(kw)).length;
    const bScore = productKeywords.filter(kw =>
      b.title.toLowerCase().includes(kw)).length;

    return bScore - aScore;
  }).slice(0, 6); // Limit to 6 products
}

function detectMentionedProducts(query: string, products: Product[]): Product[] {
  const lowerQuery = query.toLowerCase();
  const mentionedProducts: Product[] = [];

  // Check if any product names are mentioned in the query
  products.forEach(product => {
    const productTitle = product.title.toLowerCase();
    const productWords = productTitle.split(' ');

    // Check for exact product name match
    if (lowerQuery.includes(productTitle)) {
      mentionedProducts.push(product);
      return;
    }

    // Check for partial matches (at least 2 significant words)
    const significantWords = productWords.filter(word => word.length > 3);
    if (significantWords.length >= 2) {
      const matchedWords = significantWords.filter(word => lowerQuery.includes(word));
      if (matchedWords.length >= Math.min(2, significantWords.length)) {
        mentionedProducts.push(product);
      }
    }
  });

  // Also check semantic keywords
  for (const [category, keywords] of Object.entries(config.semanticKeywords)) {
    const hasQueryKeyword = keywords.some(keyword => lowerQuery.includes(keyword));
    if (hasQueryKeyword) {
      products.forEach(product => {
        const productText = `${product.title} ${product.description || ''} ${product.category || ''}`.toLowerCase();
        const hasProductKeyword = keywords.some(keyword => productText.includes(keyword));
        if (hasProductKeyword && !mentionedProducts.find(p => p._id === product._id)) {
          mentionedProducts.push(product);
        }
      });
    }
  }

  return mentionedProducts.slice(0, 1); // Limit to 1 product
}

// Check if query is asking to "show products" without specifics
function isVagueProductRequest(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  const vaguePatterns = [
  /^show me products?$/,
  /^im looking for some products?$/,
  /^im looking for products?$/,
  /^im looking for all products?$/,
  /^show me all products?$/,
  /^show me (some )?products?$/,
  /^i want to buy some products?$/,
  /^i want to buy products?$/,
  /^what products? do you have$/,
  /^(do you )?have any products?$/,
  /^show me what you have$/,
  /^what do you sell$/,
  /^what's available$/,
  /^what do you offer$/,
  /^list products$/,
  /^show items$/,
  /^show inventory$/,
  /^what can i buy$/,
  /^what's in stock$/,
  /^show me something$/,
  /^what do you recommend$/,
  /^any products?$/,
  /^show products?$/,
  /^display products?$/,
  /^list all items$/,
  /^show everything$/,
  /^what items do you have$/,
  /^browse products?$/,
  /^view products?$/,
  /^what do you got$/,
  /^got anything for sale$/,
  /^can i see your products?$/,
  /^let me see what you have$/,
  /^give me your product list$/,
  /^what are you selling$/,
  /^sell me something$/,
  /^what stuff do you have$/,
  /^what can i get$/,
  /^i want to see products$/,
  /^i need some products$/,
  /^what do you have in stock$/,
  /^can you show me products$/,
  /^i want to browse$/,
  /^let me browse$/,
  /^what's in your shop$/,
  /^do you have anything$/,
  /^i'm browsing$/,
  /^can i look at your items$/,
  /^anything to buy$/,
  /^open catalog$/,
  /^product catalog$/,
  /^inventory list$/,
  /^browse catalog$/,
  /^explore products$/,
  /^i want to shop$/,
  /^shop now$/,
  /^shop products$/,
  /^take me shopping$/,
  /^i'm here to shop$/,
  /^just looking around$/,
  /^let me shop$/,
  /^shopping list$/,
  /^what can i shop$/,
];


  return vaguePatterns.some(pattern => pattern.test(lowerQuery.trim()));
}

// Initialize services with timeout protection
const initializeServices = () => {
  const requiredEnvVars = ['OPENAI_API_KEY', 'WP_DB_HOST', 'WP_DB_USER', 'WP_DB_PASSWORD', 'WP_DB_NAME'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
  }

  return {
    openai: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      timeout: config.timeoutMs
    }),
    pool: mysql.createPool({
      host: process.env.WP_DB_HOST,
      user: process.env.WP_DB_USER,
      password: process.env.WP_DB_PASSWORD || '',
      database: process.env.WP_DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: config.timeoutMs
    })
  };
};

let services: ReturnType<typeof initializeServices>;

try {
  services = initializeServices();
} catch (initError) {
  console.error("Service initialization failed:", initError);
  throw initError;
}

// Helper function to generate quick response without AI when possible
async function generateQuickResponse(query: string, products: Product[]): Promise<string | null> {
  const lowerQuery = query.toLowerCase().trim();

  // Greetings
  if (/^(hi|hello|hey|greetings|good (morning|afternoon|evening))/.test(lowerQuery)) {
    return `Hello! Welcome to ${config.storeName}. How can I assist you today?`;
  }

  // Thanks
  if (/^(thanks|thank you|appreciate it|cheers)/.test(lowerQuery)) {
    return "You're welcome! Is there anything else I can help you with?";
  }

  // Goodbye
  if (/^(bye|goodbye|see you|farewell)/.test(lowerQuery)) {
    return "Goodbye! Feel free to come back if you need any more assistance.";
  }

  // Store information
  if (/^(what do you sell|what products do you have|what kind of store is this)/.test(lowerQuery)) {
    const categories = [...new Set(products.map(p => p.category).filter(Boolean))];
    const categoryList = categories.length > 0
      ? `We offer ${categories.slice(0, 3).join(', ')}${categories.length > 3 ? ' and more' : ''}.`
      : 'We offer a variety of products.';
    return `${categoryList} What specifically are you looking for today?`;
  }

  // Help request
  if (/^(help|what can you do|how does this work)/.test(lowerQuery)) {
    return "I can help you find products, check prices, and answer questions about our inventory. Just tell me what you're looking for!";
  }

  // About the assistant
  if (/^(who are you|what are you|what's your name)/.test(lowerQuery)) {
    return `I'm your shopping assistant at ${config.storeName}, here to help you find the perfect products!`;
  }
  if (/^(i want to buy|i want to purchase)/.test(lowerQuery)) {
    return `I'm here to help you buy products! What are you looking to purchase?`;
  }

  return null;
}

async function generateComparisonResponse(product1: Product, product2: Product, openai: OpenAI): Promise<string> {
  try {
    const prompt = `You are a helpful shopping assistant comparing two products for a customer. 
    Provide a detailed but concise comparison that helps the customer make an informed decision.

    **Comparison Guidelines:**
    1. Start with a brief overview of both products
    2. Highlight key differences in features, specifications, and price
    3. Mention which product might be better for different use cases
    4. Include pros and cons for each product
    5. Keep the tone neutral and factual
    6. Limit response to 300 words

Product 1: ${product1.title}
Price: $${product1.price}
Description: ${product1.description || 'No description available'}
Category: ${product1.category || 'General'}

Product 2: ${product2.title}
Price: $${product2.price}
Description: ${product2.description || 'No description available'}
Category: ${product2.category || 'General'}

Please provide a helpful comparison that covers:
1. Key differences between the products
2. Price comparison and value for money
3. Which product might be better for different use cases
4. Any notable pros and cons of each

Keep your response conversational, helpful, and under 300 words. Focus on practical differences that would help a customer make a decision.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a helpful shopping assistant who provides clear, honest product comparisons to help customers make informed decisions."
        },
        { role: "user", content: prompt }
      ],
      max_tokens: 400,
      temperature: 0.7,
    });

    const response = completion.choices[0]?.message?.content?.trim();

    if (!response) {
      throw new Error("No response from AI");
    }

    return response;
  } catch (error) {
    console.error("AI Comparison Error:", error);

    // Fallback comparison when AI fails
    return `Here's a comparison between ${product1.title} and ${product2.title}:

**Price Comparison:**
• ${product1.title}: $${product1.price}
• ${product2.title}: $${product2.price}
• Price difference: $${Math.abs(product1.price - product2.price).toFixed(2)}

**Key Details:**
• Both products are available in our store
• ${product1.title} ${product1.price > product2.price ? 'is more expensive' : 'is less expensive'} than ${product2.title}
• Consider your budget and specific needs when choosing

${product1.description && product2.description ?
        `**Product Details:**\n• ${product1.title}: ${product1.description.substring(0, 100)}...\n• ${product2.title}: ${product2.description.substring(0, 100)}...` :
        ''
      }

Feel free to ask me specific questions about either product to help you decide!`;
  }
}

// New function to handle general questions with AI
async function handleGeneralQuestion(query: string, history: ChatMessage[] = [], products: Product[] = []): Promise<{ reply: string; mentionedProducts?: Product[] }> {
  try {
    // Check if specific products are mentioned
    const mentionedProducts = detectMentionedProducts(query, products);

    const recentHistory = history.slice(-12);

    const prompt = `You are a helpful shopping assistant for store named Plugin. 
    The user has asked: "${query}". 
    -Plugin is a store that mostly sells card printers, projectors, customer services and electronics.
    -Please provide a helpful response to this general question. 
    -Keep your response concise and friendly, and focus on being helpful to the shopper.
    -If you don't know the answer, suggest they rephrase or ask for more details.
    -If query is not about greeting, you, store, products, or shopping, politely decline to answer.
    -If they use abusive language, respond with a friendly reminder to keep the conversation respectful.
    ${mentionedProducts.length > 0 ?
        `-The user mentioned products that we have in stock: ${mentionedProducts.map(p => p.title).join(', ')}. 
       -Acknowledge these products in your response but don't show details yet.` : ''}
    `;

    const completion = await services.openai.chat.completions.create({
      model: config.generalAiModel,
      messages: [
        { role: "system", content: "You are a helpful shopping assistant." },
        ...recentHistory,
        { role: "user", content: prompt }
      ],
      max_tokens: 200,
      temperature: 0.7,
    });

    const aiReply = completion.choices[0]?.message?.content?.trim() ||
      "I'm not sure how to answer that. Could you rephrase your question?";

    return { reply: aiReply, mentionedProducts };
  } catch (error) {
    console.error("AI General Question Error:", error);
    const mentionedProducts = detectMentionedProducts(query, products);
    return {
      reply: config.fallbackResponses[Math.floor(Math.random() * config.fallbackResponses.length)],
      mentionedProducts
    };
  }
}

function isRecommendationQuery(query: string): boolean {
  const recommendationKeywords = [
    'recommend', 'suggest', 'show me', 'what do you have',
    'products', 'items', 'looking for', 'options', 'choices',
    'offer', 'available', 'have any', 'provide'
  ];
  return recommendationKeywords.some(keyword =>
    query.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Main API endpoint with proper confirmation handling
export async function POST(req: NextRequest): Promise<NextResponse<AssistantResponse>> {
  let connection: mysql.PoolConnection | null = null;
  let session: ChatSession | undefined;

  try {
    const body = await req.json();
    const { query, history = [], lastShownProducts, sessionId } = requestSchema.parse(body);

   if (sessionId && sessions.has(sessionId)) {
      session = sessions.get(sessionId)!;
      // Clear existing timeout and set new one
      if (session.timeout) clearTimeout(session.timeout);
      session.timeout = setTimeout(() => {
        sessions.delete(sessionId);
      }, SESSION_TIMEOUT);
      session.updatedAt = Date.now();
    } else {
      // Create new session
      session = {
        id: generateSessionId(),
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        timeout: setTimeout(() => {
          sessions.delete(sessionId || session!.id);
        }, SESSION_TIMEOUT)
      };
      sessions.set(session.id, session);
    }
 
    // Get or create session
    session = getOrCreateSession(sessionId ?? undefined);
    
    // Use session history if no history was provided
    const currentHistory = history.length > 0 ? 
      manageConversationHistory(history, query) : 
      manageConversationHistory(session.history, query);

    const normalizedProducts: Product[] | undefined = lastShownProducts?.map(p => ({
      ...p,
      slug: String(p.slug ?? "")
    }));

    const context = extractContextFromHistory(currentHistory, normalizedProducts);

    console.log('Context:', context);
    console.log('User query:', query);
    console.log('Last shown products:', normalizedProducts?.map(p => p.title));

    // Handle confirmation responses
    const confirmation = isConfirmationResponse(query);
    console.log('Confirmation:', confirmation);

    if (confirmation !== null && context.pendingPurchase) {
      console.log('Handling confirmation for pending purchase');
      if (confirmation === 'yes') {
        if (!context.pendingPurchase.productId) {
          session.history = manageConversationHistory(currentHistory, "There was an issue processing your purchase.");
          return NextResponse.json({
            reply: "I'm sorry, there was an issue processing your purchase. Please try again.",
            history: session.history,
            phase: 'recommendation',
            sessionId: session.id
          });
        }

        const checkoutUrl = `${config.baseUrl}/checkout/?add-to-cart=${context.pendingPurchase.productId}`;
        session.history = manageConversationHistory(currentHistory, `Redirecting you to purchase ${context.pendingPurchase.productTitle}`);
        return NextResponse.json({
          reply: `Great! Redirecting you to complete your purchase of ${context.pendingPurchase.productTitle}...`,
          redirect: checkoutUrl,
          history: session.history,
          phase: 'recommendation',
          sessionId: session.id
        });
      } else {
        session.history = manageConversationHistory(currentHistory, "No problem! Let me know if there's anything else I can help you with.");
        return NextResponse.json({
          reply: "No problem! Let me know if there's anything else I can help you with or if you'd like to see other products.",
          history: session.history,
          phase: 'recommendation',
          sessionId: session.id
        });
      }
    }

    if (confirmation !== null && context.pendingAction) {
      console.log('Handling confirmation for pending action');
      let responseMessage = "I'd be happy to help with that!";
      if (confirmation === 'yes') {
        if (context.pendingAction === 'view') {
          responseMessage = "Great! Please let me know which specific product you'd like to view details for.";
        } else if (context.pendingAction === 'cart') {
          responseMessage = "Perfect! Please specify which product you'd like to add to your cart.";
        }
      } else {
        responseMessage = "No problem! How else can I assist you today?";
      }

      session.history = manageConversationHistory(currentHistory, responseMessage);
      return NextResponse.json({
        reply: responseMessage,
        history: session.history,
        phase: 'recommendation',
        sessionId: session.id
      });
    }

    // Try quick response for common queries
    const quickResponse = await generateQuickResponse(query, []);
    if (quickResponse) {
      session.history = manageConversationHistory(currentHistory, quickResponse);
      return NextResponse.json({
        reply: quickResponse,
        history: session.history,
        phase: 'general',
        sessionId: session.id
      });
    }

    // Get database connection with timeout
    connection = await Promise.race([
      services.pool.getConnection(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Database connection timeout')), config.timeoutMs)
      )
    ]);

    // Fetch products
    const [products] = await Promise.race([
      connection.query<any[]>(`
        SELECT 
          p.ID AS _id,
          p.post_title AS title,
          CAST(pm_price.meta_value AS DECIMAL(10,2)) AS price,
          100 AS inventory,
          p.post_content AS description,
          COALESCE(p.post_name, '') AS slug,
          pm_thumb_img.guid AS image_url,
          GROUP_CONCAT(DISTINCT t.name SEPARATOR ', ') AS category
        FROM wp_posts p
        LEFT JOIN wp_postmeta pm_price ON p.ID = pm_price.post_id AND pm_price.meta_key = '_price'
        LEFT JOIN wp_postmeta pm_thumb ON p.ID = pm_thumb.post_id AND pm_thumb.meta_key = '_thumbnail_id'
        LEFT JOIN wp_posts pm_thumb_img ON pm_thumb.meta_value = pm_thumb_img.ID
        LEFT JOIN wp_term_relationships tr ON p.ID = tr.object_id
        LEFT JOIN wp_term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'product_cat'
        LEFT JOIN wp_terms t ON tt.term_id = t.term_id
        WHERE p.post_type = 'product'
          AND p.post_status = 'publish'
          AND pm_price.meta_value IS NOT NULL
          AND pm_price.meta_value != ''
        GROUP BY p.ID, p.post_title, pm_price.meta_value, p.post_content, p.post_name, pm_thumb_img.guid
      `),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Database query timeout')), config.timeoutMs)
      )
    ]);

    if (!products.length) {
      session.history = manageConversationHistory(currentHistory, "Currently we don't have any products available. Please check back later.");
      return NextResponse.json({
        reply: "Currently we don't have any products available. Please check back later.",
        history: session.history,
        phase: 'general',
        sessionId: session.id
      });
    }

    const mappedProducts: Product[] = products.map(p => ({
      ...p,
      inventory: 100,
      image_url: p.image_url || undefined,
      category: p.category || undefined
    }));

    // Handle nonsense queries
    if (isNonsenseQuery(query)) {
      const randomResponse = config.nonsenseResponses[
        Math.floor(Math.random() * config.nonsenseResponses.length)
      ];

      session.history = manageConversationHistory(currentHistory, randomResponse);
      return NextResponse.json({
        reply: randomResponse,
        history: session.history,
        phase: 'general',
        sessionId: session.id
      });
    }

    const currentPhase = detectPhase(query, currentHistory || [], context);

    // PHASE 1: GENERAL QUESTIONS
    if (currentPhase === 'general') {
      const quickResponseWithProducts = await generateQuickResponse(query, mappedProducts);
      if (quickResponseWithProducts) {
        session.history = manageConversationHistory(currentHistory, quickResponseWithProducts);
        return NextResponse.json({
          reply: quickResponseWithProducts,
          history: session.history,
          phase: 'general',
          sessionId: session.id
        });
      }

      const { reply: aiResponse, mentionedProducts } = await handleGeneralQuestion(query, currentHistory, mappedProducts);
      let finalReply = aiResponse;

      if (mentionedProducts && mentionedProducts.length > 0) {
        const customerQuery = extractProductSuggestionFromQuery(query);
        finalReply += `\n\nIf you'd like to see these products, just type: "show me ${customerQuery}"`;
      }

      session.history = manageConversationHistory(currentHistory, finalReply);
      return NextResponse.json({
        reply: finalReply,
        history: session.history,
        phase: 'general',
        sessionId: session.id
      });
    }

    // Handle vague product requests
    if (isVagueProductRequest(query)) {
      const randomQuestion = config.vagueProductQuestions[
        Math.floor(Math.random() * config.vagueProductQuestions.length)
      ];

      session.history = manageConversationHistory(currentHistory, randomQuestion);
      return NextResponse.json({
        reply: randomQuestion,
        history: session.history,
        phase: 'recommendation',
        sessionId: session.id
      });
    }

    // Handle direct action requests
    const directAction = isDirectActionRequest(query, mappedProducts);
    if (directAction.action) {
      if (directAction.vague) {
        const relatedProducts = findMatchingProducts(query, mappedProducts).slice(0, 3);
        let reply = '';

        if (relatedProducts.length > 0) {
          reply = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">`;
          
          if (directAction.action === 'buy') {
            reply += `<h3 style="color: #2d3748; margin-bottom: 16px;">Here are some products you might want to buy:</h3>`;
          } else if (directAction.action === 'view') {
            reply += `<h3 style="color: #2d3748; margin-bottom: 16px;">Here are some products you might want to view:</h3>`;
          } else if (directAction.action === 'cart') {
            reply += `<h3 style="color: #2d3748; margin-bottom: 16px;">Here are some products you might want to add to cart:</h3>`;
          }

          reply += relatedProducts.map(product => `
            <div style="background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              ${product.image_url ? `
                <img src="${product.image_url}" 
                     style="max-width: 100%; height: 120px; object-fit: contain; margin-bottom: 12px; border-radius: 4px;">
              ` : ''}
              <h4 style="margin: 0 0 8px 0; color: #2d3748;">${product.title}</h4>
              <p style="margin: 0 0 8px 0; color: #4a5568; font-size: 14px;">
                ${product.description ? product.description.substring(0, 100) + (product.description.length > 100 ? '...' : '') : ''}
              </p>
              <p style="margin: 0 0 12px 0; font-weight: bold; color: #2b6cb0;">$${product.price.toFixed(2)}</p>
              <div style="display: flex; gap: 8px;">
                <a href="${config.baseUrl}/product/${product.slug}" 
                   style="padding: 8px 12px; background: #edf2f7; color: #2b6cb0; border-radius: 4px; text-decoration: none; font-size: 14px;">
                  View Details
                </a>
                ${directAction.action === 'buy' ? `
                  <a href="${config.baseUrl}/checkout/?add-to-cart=${product._id}" 
                     style="padding: 8px 12px; background: #2b6cb0; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
                    Buy Now
                  </a>
                ` : ''}
                ${directAction.action === 'cart' ? `
                  <a href="${config.baseUrl}/?add-to-cart=${product._id}" 
                     style="padding: 8px 12px; background: #38a169; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
                    Add to Cart
                  </a>
                ` : ''}
              </div>
            </div>
          `).join('');

          reply += `
            <p style="margin-top: 16px; color: #718096;">
              Or tell me more specifically what you're looking for.
            </p>
          </div>`;
        } else {
          if (directAction.action === 'buy') {
            reply = 'What would you like to buy? I can help you find it.';
          } else if (directAction.action === 'view') {
            reply = 'What product would you like to view?';
          } else if (directAction.action === 'cart') {
            reply = 'What would you like to add to your cart?';
          }
        }

        session.history = manageConversationHistory(currentHistory, reply);
        return NextResponse.json({
          reply,
          history: session.history,
          phase: 'recommendation',
          lastShownProducts: relatedProducts.length > 0 ? relatedProducts : undefined,
          sessionId: session.id
        });
      }
      
      if (directAction.productName && directAction.product) {
        if (directAction.action === 'buy') {
          const checkoutUrl = `${config.baseUrl}/checkout/?add-to-cart=${directAction.product._id}`;
          session.history = manageConversationHistory(currentHistory, `Redirecting you to purchase ${directAction.product.title}`);
          return NextResponse.json({
            reply: `Great! Redirecting you to complete your purchase of ${directAction.product.title}...`,
            redirect: checkoutUrl,
            history: session.history,
            phase: 'recommendation',
            sessionId: session.id
          });
        }

        let confirmationMessage = '';
        if (directAction.action === 'view') {
          confirmationMessage = `Would you like to view details for ${directAction.product.title}?`;
        } else if (directAction.action === 'cart') {
          confirmationMessage = `Would you like to add ${directAction.product.title} (${directAction.product.price}) to your cart?`;
        }

        session.history = manageConversationHistory(currentHistory, confirmationMessage);
        return NextResponse.json({
          reply: confirmationMessage,
          history: session.history,
          phase: 'recommendation',
          sessionId: session.id
        });
      }
    }

    // Handle product comparison requests
    if (currentPhase === 'comparison') {
      const comparison = isComparisonQuery(query);
      if (comparison) {
        const product1 = findBestProductMatch(comparison.product1, mappedProducts);
        const product2 = findBestProductMatch(comparison.product2, mappedProducts);

        if (!product1 || !product2) {
          const missingProducts = [];
          if (!product1) missingProducts.push(comparison.product1);
          if (!product2) missingProducts.push(comparison.product2);

          const reply = `I couldn't find ${missingProducts.join(' and ')} in our inventory.`;
          const relatedProducts = findMatchingProducts(query, mappedProducts).slice(0, 3);

          session.history = manageConversationHistory(currentHistory, reply);
          return NextResponse.json({
            reply,
            history: session.history,
            phase: 'recommendation',
            lastShownProducts: relatedProducts,
            sessionId: session.id
          });
        }

        try {
          const comparisonResponse = await generateComparisonResponse(product1, product2, services.openai);
          
          const reply = `
<div style="font-family: 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; color: #333; max-width: 800px; margin: 0 auto;">
  <h2 style="color: #2d3748; font-size: 22px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 20px;">
    Comparison: ${product1.title} vs ${product2.title}
  </h2>

  <div style="background: #f8fafc; padding: 25px; border-radius: 12px; margin-bottom: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
    <div style="font-size: 16px; line-height: 1.7; color: #4a5568;">
      ${comparisonResponse
        .replace(/\n\n/g, '</div><div style="margin-top: 16px;">')
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/•/g, '•')
      }
    </div>
  </div>

  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 25px; margin-top: 30px;">
    <!-- Product 1 Card -->
    <div style="background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
      <div style="background: #e6fffa; color: #065f46; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; display: inline-block; margin-bottom: 8px;">
        Product 1
      </div>
      ${product1.image_url ? `
        <img src="${product1.image_url}" loading="lazy" 
             style="width: 100%; height: 180px; object-fit: contain; border-radius: 6px; margin-bottom: 15px; background: #f8fafc; border: 1px solid #edf2f7;"/>
      ` : ''}
      <h3 style="color: #2d3748; font-size: 18px; margin-top: 0; margin-bottom: 10px;">${product1.title}</h3>
      <p style="font-size: 20px; color: #2b6cb0; font-weight: 600; margin: 12px 0;">$${product1.price.toFixed(2)}</p>
      <div style="display: flex; gap: 10px; margin-top: 15px;">
        <a href="${config.baseUrl}/product/${product1.slug}" 
           style="background: #4299e1; color: white; padding: 10px 16px; border-radius: 6px; 
                  text-decoration: none; font-size: 14px; font-weight: 500;
                  display: inline-block; text-align: center; flex: 1;">
          View Details
        </a>
        <a href="${config.baseUrl}/checkout/?add-to-cart=${product1._id}" 
           style="background: #38a169; color: white; padding: 10px 16px; border-radius: 6px; 
                  text-decoration: none; font-size: 14px; font-weight: 500;
                  display: inline-block; text-align: center; flex: 1;">
          Buy Now
        </a>
      </div>
    </div>
    
    <!-- Product 2 Card -->
    <div style="background: #fff; padding: 20px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
      <div style="background: #fef3c7; color: #92400e; padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; display: inline-block; margin-bottom: 8px;">
        Product 2
      </div>
      ${product2.image_url ? `
        <img src="${product2.image_url}" loading="lazy" 
             style="width: 100%; height: 180px; object-fit: contain; border-radius: 6px; margin-bottom: 15px; background: #f8fafc; border: 1px solid #edf2f7;"/>
      ` : ''}
      <h3 style="color: #2d3748; font-size: 18px; margin-top: 0; margin-bottom: 10px;">${product2.title}</h3>
      <p style="font-size: 20px; color: #2b6cb0; font-weight: 600; margin: 12px 0;">$${product2.price.toFixed(2)}</p>
      <div style="display: flex; gap: 10px; margin-top: 15px;">
        <a href="${config.baseUrl}/product/${product2.slug}" 
           style="background: #4299e1; color: white; padding: 10px 16px; border-radius: 6px; 
                  text-decoration: none; font-size: 14px; font-weight: 500;
                  display: inline-block; text-align: center; flex: 1;">
          View Details
        </a>
        <a href="${config.baseUrl}/checkout/?add-to-cart=${product2._id}" 
           style="background: #38a169; color: white; padding: 10px 16px; border-radius: 6px; 
                  text-decoration: none; font-size: 14px; font-weight: 500;
                  display: inline-block; text-align: center; flex: 1;">
          Buy Now
        </a>
      </div>
    </div>
  </div>

  <p style="text-align: center; margin-top: 25px; color: #718096; font-size: 14px;">
    Need more help deciding? Feel free to ask me anything about these products!
  </p>
</div>
`;

          session.history = manageConversationHistory(currentHistory, reply);
          return NextResponse.json({
            reply,
            history: session.history,
            phase: 'recommendation',
            lastShownProducts: [product1, product2],
            sessionId: session.id
          });

        } catch (error) {
          console.error('Comparison generation error:', error);
          const fallbackComparison = await generateComparisonResponse(product1, product2, services.openai);

          const reply = `
<div style="font-family: 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; color: #333; max-width: 800px; margin: 0 auto;">
  <h2 style="color: #2d3748; font-size: 22px; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 20px;">
    Comparison: ${product1.title} vs ${product2.title}
  </h2>

  <div style="background: #f8fafc; padding: 25px; border-radius: 12px; margin-bottom: 30px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
    <div style="font-size: 16px; line-height: 1.7; color: #4a5568;">
      ${fallbackComparison.replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}
    </div>
  </div>
</div>
`;

          session.history = manageConversationHistory(currentHistory, reply);
          return NextResponse.json({
            reply,
            history: session.history,
            phase: 'recommendation',
            lastShownProducts: [product1, product2],
            sessionId: session.id
          });
        }
      }
    }

    // PHASE 2: PRODUCT RECOMMENDATION
    const matchingProducts = findMatchingProducts(query, mappedProducts);
    const priceRange = detectPriceRange(query);
    const productKeywords = extractProductKeywords(query);

    const recommendationKeywords = [
      'recommend', 'suggest', 'show me', 'what do you have',
      'products', 'items', 'looking for', 'options', 'choices',
      'offer', 'available', 'have any', 'provide'
    ];

    const isRecommendationQuery = recommendationKeywords.some(keyword =>
      query.toLowerCase().includes(keyword.toLowerCase())
    );

    if (isRecommendationQuery && productKeywords.length === 0) {
      const randomQuestion = config.vagueProductQuestions[
        Math.floor(Math.random() * config.vagueProductQuestions.length)
      ];

      session.history = manageConversationHistory(currentHistory, randomQuestion);
      return NextResponse.json({
        reply: randomQuestion,
        history: session.history,
        phase: 'recommendation',
        sessionId: session.id
      });
    }

    if (matchingProducts.length === 0) {
      let reply = '';

      if (priceRange && productKeywords.length > 0) {
        const priceText = priceRange.max ? `under ${priceRange.max}` : `over ${priceRange.min}`;
        reply = `We don't have ${productKeywords.join(' ')} ${priceText}.`;
      } else if (priceRange) {
        const priceText = priceRange.max ? `under ${priceRange.max}` : `over ${priceRange.min}`;
        reply = `We don't have products ${priceText}.`;
      } else if (productKeywords.length > 0) {
        reply = `We don't have "${productKeywords.join(' ')}" in stock.`;
      } else {
        reply = generateClarifyingQuestion(mappedProducts);
      }

      session.history = manageConversationHistory(currentHistory, reply);
      return NextResponse.json({
        reply,
        history: session.history,
        phase: 'recommendation',
        sessionId: session.id
      });
    }

    if (isRecommendationQuery || productKeywords.length > 0) {
      let reply = '';

      if (priceRange && productKeywords.length > 0) {
        const priceText = priceRange.max ? `under ${priceRange.max}` : `over ${priceRange.min}`;
        reply = `Here are the ${productKeywords.join(' ')} products we have ${priceText}:\n\n`;
      } else if (priceRange) {
        const priceText = priceRange.max ? `under ${priceRange.max}` : `over ${priceRange.min}`;
        reply = `Here are our products ${priceText}:\n\n`;
      } else if (productKeywords.length > 0) {
        reply = `Here are the some products you might be interested in:\n\n`;
      } else {
        reply = `Here are some products you might be interested in:\n\n`;
      }

      const mobile = isMobileDevice(req);
      let productHTML = matchingProducts.map(product => `
<div style="background: #fff; padding: 16px; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); border: 1px solid #eee;">
  ${product.image_url ? `
    <img src="${product.image_url}" loading="lazy" 
         style="width: 100%; height: 180px; object-fit: contain; border-radius: 8px; margin-bottom: 12px;"/>
  ` : ''}
  <h3 style="color: #2d3748; font-size: 18px; margin-top: 0; margin-bottom: 8px;">${product.title}</h3>
  <p style="color: #666; font-size: 14px; margin-bottom: 12px;">
    ${product.description ? product.description.substring(0, 100) + (product.description.length > 100 ? '...' : '') : ''}
  </p>
  <p style="font-size: 20px; color: #2b6cb0; font-weight: 600; margin: 12px 0;">${product.price}</p>
  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
    <a href="${config.baseUrl}/product/${product.slug}" 
       ${mobile ? 'class="preview-link"' : 'target="_blank"'}
       style="background: #f8fafc; color: #2563EB; padding: 8px 12px; border-radius: 6px; 
              text-decoration: none; border: 1px solid #e2e8f0; font-size: 14px;">
      View Details
    </a>
    <a href="${config.baseUrl}/checkout/?add-to-cart=${product._id}" 
       ${mobile ? 'class="preview-link"' : 'target="_blank"'}
       style="background: #2563EB; color: #fff; padding: 8px 12px; border-radius: 6px; 
              text-decoration: none; font-size: 14px;">
      Buy Now
    </a>
    <a href="${config.baseUrl}/shop/?add-to-cart=${product._id}" 
       ${mobile ? 'class="preview-link"' : 'target="_blank"'}
       style="background: #059669; color: #fff; padding: 8px 12px; border-radius: 6px; 
              text-decoration: none; font-size: 14px;">
      Add to Cart
    </a>
  </div>
</div>
`).join('');

      if (mobile) {
        productHTML += `
<script>
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.preview-link').forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      const url = this.getAttribute('href');
      window.open(url, 'preview', 'width=800,height=600,scrollbars=yes');
    });
  });
});
</script>
`;
      }

      reply += productHTML;

      if (matchingProducts.length > 0) {
        reply += `\n\nNeed help choosing or have questions about any of these? Just ask!`;
      }

      session.history = manageConversationHistory(currentHistory, reply);
      return NextResponse.json({
        reply,
        history: session.history,
        phase: 'recommendation',
        lastShownProducts: matchingProducts,
        sessionId: session.id
      });
    } else {
      const reply = `I'm not sure what you're looking for. Could you be more specific or ask for product recommendations?`;

      session.history = manageConversationHistory(currentHistory, reply);
      return NextResponse.json({
        reply,
        history: session.history,
        phase: 'recommendation',
        sessionId: session.id
      });
    }

  } catch (err) {
    console.error("Customer Assistant Error:", err);
    const randomFallback = config.fallbackResponses[
      Math.floor(Math.random() * config.fallbackResponses.length)
    ];

    return NextResponse.json(
      {
        reply: randomFallback,
        error: (err as Error).message,
        phase: 'general',
        sessionId: session?.id
      },
      { status: 500 }
    );
  } finally {
    if (connection) connection.release();
  }
}
