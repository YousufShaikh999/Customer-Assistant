import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import mysql from 'mysql2/promise';
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

// Enhanced Product Interface with better typing
interface Product {
  matchScore?: number;
  slug: string;
  _id: string;
  title: string;
  price: number;
  inventory: number;
  description: string;
  category?: string;
  image_url?: string;
  short_description?: string;
  rating?: number;
  review_count?: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface AssistantResponse {
  reply: string;
  redirect?: string;
  product?: string;
  addToCart?: {
    id: string;
    title: string;
    price: number;
    image_url?: string;
    quantity?: number;
  };
  history?: ChatMessage[];
  error?: string;
  suggestions?: string[];
  productCount?: number;
}

// Enhanced request validation
const requestSchema = z.object({
  query: z.string().min(1).max(1000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    timestamp: z.string().optional()
  })).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional()
});

// Enhanced Configuration with better organization
interface Config {
  maxHistoryLength: number;
  aiModel: "gpt-3.5-turbo" | "gpt-4" | "gpt-4-turbo";
  baseUrl: string;
  maxProducts: number;
  cacheTimeout: number;
  viewKeywords: string[];
  redirectionKeywords: string[];
  storeName: string;
  semanticKeywords: Record<string, string[]>;
  eventKeywords: Record<string, string[]>;
  priceRanges: Record<string, [number, number]>;
}

const config: Config = {
  maxHistoryLength: 8,
  aiModel: "gpt-3.5-turbo",
  baseUrl: process.env.STORE_BASE_URL || "http://plugin.ijkstaging.com",
  maxProducts: 8,
  cacheTimeout: 300000, // 5 minutes
  viewKeywords: [
    'show me', 'view', 'navigate to', 'head to', 'go to',
    'see', 'see more', 'see details', 'details', 'details of',
    'learn more', 'open', 'visit', 'explore', 'look at',
    'take me to', 'redirect me to', 'check out', 'move to',
    'click here', 'head over to', 'take a look at', 'take me',
    'search for', 'access', 'load', 'jump to', 'browse'
  ],
  redirectionKeywords: [
    'buy', 'buy now', 'purchase', 'order', 'checkout', 'get this', 'i want this'
  ],
  storeName: process.env.STORE_NAME || "our store",

  // Enhanced semantic keyword mapping
  semanticKeywords: {
    // Furniture & Home
    'seating': ['chair', 'stool', 'bench', 'sofa', 'couch', 'armchair', 'ottoman', 'recliner'],
    'tables': ['table', 'desk', 'dining table', 'coffee table', 'side table', 'nightstand', 'end table'],
    'storage': ['cabinet', 'drawer', 'shelf', 'bookshelf', 'wardrobe', 'closet', 'chest', 'organizer'],
    'lighting': ['lamp', 'light', 'chandelier', 'bulb', 'fixture', 'sconce', 'pendant'],
    'bedding': ['bed', 'mattress', 'pillow', 'sheet', 'blanket', 'comforter', 'duvet', 'pillowcase'],

    // Decoration & Party
    'party_decor': ['balloon', 'streamer', 'banner', 'confetti', 'garland', 'backdrop', 'party supplies'],
    'lighting_decor': ['candle', 'fairy lights', 'string lights', 'lantern', 'torch', 'led lights'],
    'tableware': ['plate', 'cup', 'glass', 'napkin', 'tablecloth', 'cutlery', 'dinnerware'],
    'flowers': ['flower', 'bouquet', 'vase', 'plant', 'centerpiece', 'floral arrangement'],

    // Kitchen & Dining
    'cookware': ['pan', 'pot', 'skillet', 'wok', 'bakeware', 'cookware', 'casserole'],
    'appliances': ['blender', 'mixer', 'toaster', 'microwave', 'oven', 'refrigerator', 'food processor'],
    'utensils': ['spoon', 'fork', 'knife', 'spatula', 'whisk', 'tongs', 'ladle'],

    // Electronics
    'audio': ['speaker', 'headphone', 'microphone', 'stereo', 'radio', 'earbuds'],
    'computing': ['laptop', 'computer', 'tablet', 'phone', 'monitor', 'keyboard', 'mouse'],
    'gaming': ['console', 'controller', 'game', 'headset', 'gaming chair'],

    // Clothing & Accessories
    'clothing': ['shirt', 'pants', 'dress', 'jacket', 'shoes', 'hat', 'sweater'],
    'accessories': ['bag', 'wallet', 'belt', 'watch', 'jewelry', 'sunglasses', 'purse'],

    // Sports & Fitness
    'fitness': ['weight', 'dumbbell', 'treadmill', 'yoga mat', 'exercise bike', 'resistance band'],
    'outdoor': ['tent', 'sleeping bag', 'backpack', 'hiking boots', 'camping gear'],

    // Beauty & Personal Care
    'skincare': ['cream', 'lotion', 'serum', 'cleanser', 'moisturizer', 'sunscreen'],
    'makeup': ['lipstick', 'foundation', 'mascara', 'eyeshadow', 'blush', 'concealer'],

    // Tools & Hardware
    'tools': ['hammer', 'screwdriver', 'drill', 'wrench', 'saw', 'pliers'],
    'hardware': ['screw', 'nail', 'bolt', 'wire', 'cable', 'connector']
  },

  // Enhanced event-based keyword mapping
  eventKeywords: {
    'birthday': ['balloon', 'candle', 'cake', 'party hat', 'banner', 'streamer', 'confetti', 'gift wrap', 'decoration', 'birthday supplies'],
    'wedding': ['flower', 'candle', 'vase', 'tablecloth', 'centerpiece', 'decoration', 'lighting', 'chair cover', 'wedding decor'],
    'christmas': ['tree', 'ornament', 'light', 'garland', 'wreath', 'decoration', 'candle', 'christmas lights'],
    'halloween': ['pumpkin', 'decoration', 'candle', 'light', 'costume', 'mask', 'spooky decor'],
    'thanksgiving': ['candle', 'centerpiece', 'tablecloth', 'decoration', 'fall decoration', 'autumn decor'],
    'valentine': ['flower', 'candle', 'chocolate', 'gift', 'heart decoration', 'romantic lighting', 'valentine gift'],
    'baby_shower': ['balloon', 'decoration', 'cake', 'gift', 'banner', 'centerpiece', 'baby supplies'],
    'graduation': ['balloon', 'banner', 'decoration', 'cap', 'gift', 'party supplies', 'graduation gift'],
    'new_year': ['light', 'decoration', 'balloon', 'confetti', 'party supplies', 'champagne glass', 'new year decor'],
    'easter': ['decoration', 'basket', 'egg', 'bunny', 'spring decoration', 'flower', 'easter decor'],
    'housewarming': ['plant', 'candle', 'decoration', 'furniture', 'home decor', 'kitchen items', 'housewarming gift']
  },

  // Price range mapping
  priceRanges: {
    'budget': [0, 25],
    'affordable': [0, 50],
    'mid-range': [50, 150],
    'premium': [150, 500],
    'luxury': [500, Infinity]
  }
};

// Enhanced utility functions
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(text: string): string {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Enhanced product matching with better scoring
function findMatchingProducts(query: string, products: Product[]): Product[] {
  const normalizedQuery = normalizeText(query);
  const queryWords = normalizedQuery.split(' ').filter(word => word.length > 2);
  const matchedProducts: (Product & { matchScore: number })[] = [];

  products.forEach(product => {
    const productText = normalizeText(`${product.title} ${product.description || ''} ${product.category || ''} ${product.short_description || ''}`);
    let score = 0;

    // 1. Exact phrase match (highest priority)
    if (productText.includes(normalizedQuery)) {
      score += 100;
    }

    // 2. Title exact match
    if (normalizeText(product.title).includes(normalizedQuery)) {
      score += 90;
    }

    // 3. Word matching with position bonus
    const titleWords = normalizeText(product.title).split(' ');
    let titleMatches = 0;
    let descriptionMatches = 0;

    queryWords.forEach(queryWord => {
      if (titleWords.some(titleWord => titleWord.includes(queryWord))) {
        titleMatches++;
        score += 15;
      }
      if (productText.includes(queryWord)) {
        descriptionMatches++;
        score += 5;
      }
    });

    // 4. Bonus for high match ratio
    const matchRatio = (titleMatches + descriptionMatches) / queryWords.length;
    if (matchRatio > 0.5) {
      score += matchRatio * 20;
    }

    // 5. Category bonus
    if (product.category && normalizedQuery.includes(normalizeText(product.category))) {
      score += 25;
    }

    if (score > 15) { // Minimum threshold
      matchedProducts.push({ ...product, matchScore: score });
    }
  });

  // Add semantic matching
  for (const [category, keywords] of Object.entries(config.semanticKeywords)) {
    for (const keyword of keywords) {
      if (normalizedQuery.includes(keyword)) {
        products.forEach(product => {
          const productText = normalizeText(`${product.title} ${product.description || ''} ${product.category || ''}`);

          if (keywords.some(k => productText.includes(k)) &&
            !matchedProducts.find(p => p._id === product._id)) {
            matchedProducts.push({ ...product, matchScore: 40 });
          }
        });
      }
    }
  }

  // Add event-based matching
  for (const [event, items] of Object.entries(config.eventKeywords)) {
    if (normalizedQuery.includes(event) || normalizedQuery.includes(event.replace('_', ' '))) {
      products.forEach(product => {
        const productText = normalizeText(`${product.title} ${product.description || ''} ${product.category || ''}`);

        if (items.some(item => productText.includes(item.toLowerCase())) &&
          !matchedProducts.find(p => p._id === product._id)) {
          matchedProducts.push({ ...product, matchScore: 50 });
        }
      });
    }
  }

  // Remove duplicates and sort
  const uniqueProducts = Array.from(
    new Map(matchedProducts.map(p => [p._id, p])).values()
  ).sort((a, b) => b.matchScore - a.matchScore);

  return uniqueProducts.slice(0, config.maxProducts);
}

// Enhanced intent analysis with better patterns
interface UserIntent {
  isViewRequest: boolean;
  isBuyRequest: boolean;
  isAddToCartRequest: boolean;
  isGeneralQuery: boolean;
  isComparisonRequest: boolean;
  isPriceQuery: boolean;
  extractedProductName: string;
  detectedEvent: string | null;
  priceConstraint: number | null;
  priceRange: string | null;
}

function analyzeUserIntent(query: string): UserIntent {
  const normalizedQuery = normalizeText(query);

  const patterns = {
    isViewRequest: /(show|view|see|display|look at|find|search for|what.*do you have|any.*available|browse|explore)/i,
    isBuyRequest: /(buy|purchase|order|checkout|get me|i want to buy|purchasing)/i,
    isAddToCartRequest: /(add to cart|put in cart|cart|add this)/i,
    isGeneralQuery: /(help|suggest|recommend|need|looking for|want|advice|what should)/i,
    isComparisonRequest: /(compare|vs|versus|difference|better|best|which)/i,
    isPriceQuery: /(price|cost|how much|expensive|cheap|affordable)/i
  };

  const intent = Object.fromEntries(
    Object.entries(patterns).map(([key, pattern]) => [
      key, pattern.test(query)
    ])
  ) as Omit<UserIntent, 'extractedProductName' | 'detectedEvent' | 'priceConstraint' | 'priceRange'>;

  // Extract product name with improved patterns
  let extractedProductName = '';
  const productPatterns = [
    /(?:for|any|some|a|the)\s+([a-zA-Z\s-]+?)(?:\s+(?:for|to|that|please)|\?|$)/i,
    /(?:buy|show|find|need|want|looking for)\s+(?:me\s+)?(?:a|an|some|the)?\s*([a-zA-Z\s-]+?)(?:\s+(?:for|to|that|please)|\?|$)/i,
    /([a-zA-Z\s-]+?)(?:\s+(?:available|in stock|for sale))/i
  ];

  for (const pattern of productPatterns) {
    const match = query.match(pattern);
    if (match?.[1]) {
      extractedProductName = match[1].trim();
      break;
    }
  }

  // Event detection
  let detectedEvent: string | null = null;
  for (const event of Object.keys(config.eventKeywords)) {
    if (normalizedQuery.includes(event) || normalizedQuery.includes(event.replace('_', ' '))) {
      detectedEvent = event;
      break;
    }
  }

  // Price constraint extraction with better patterns
  let priceConstraint: number | null = null;
  const pricePatterns = [
    /(?:under|below|less than|cheaper than|max|maximum|<=?)\s*\$?([0-9,]+)/i,
    /(?:budget|afford)\s*(?:of|is)?\s*\$?([0-9,]+)/i,
    /\$([0-9,]+)\s*(?:or less|max|maximum)/i
  ];

  for (const pattern of pricePatterns) {
    const match = normalizedQuery.match(pattern);
    if (match?.[1]) {
      priceConstraint = parseFloat(match[1].replace(',', ''));
      break;
    }
  }

  // Price range detection
  let priceRange: string | null = null;
  for (const [range, _] of Object.entries(config.priceRanges)) {
    if (normalizedQuery.includes(range)) {
      priceRange = range;
      break;
    }
  }

  return {
    ...intent,
    extractedProductName,
    detectedEvent,
    priceConstraint,
    priceRange
  };
}

// Enhanced database service initialization
const initializeServices = () => {
  const requiredEnvVars = ['OPENAI_API_KEY', 'WP_DB_HOST', 'WP_DB_USER', 'WP_DB_PASSWORD', 'WP_DB_NAME'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
  }

  return {
    openai: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      timeout: 30000 // 30 second timeout
    }),
    pool: mysql.createPool({
      host: process.env.WP_DB_HOST,
      user: process.env.WP_DB_USER,
      password: process.env.WP_DB_PASSWORD || '',
      database: process.env.WP_DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
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

// Enhanced product fetching with better query optimization
async function fetchProducts(connection: mysql.PoolConnection): Promise<Product[]> {
  const [products] = await connection.query<any[]>(`
    SELECT 
      p.ID AS _id,
      p.post_title AS title,
      CAST(COALESCE(pm_price.meta_value, pm_regular_price.meta_value, 0) AS DECIMAL(10,2)) AS price,
      CAST(COALESCE(pm_stock.meta_value, 100) AS UNSIGNED) AS inventory,
      p.post_content AS description,
      p.post_excerpt AS short_description,
      p.post_name AS slug,
      pm_thumb_img.guid AS image_url,
      GROUP_CONCAT(DISTINCT t.name SEPARATOR ', ') AS category,
      CAST(COALESCE(pm_rating.meta_value, 0) AS DECIMAL(3,2)) AS rating,
      CAST(COALESCE(pm_reviews.meta_value, 0) AS UNSIGNED) AS review_count
    FROM wp_posts p
    LEFT JOIN wp_postmeta pm_price ON p.ID = pm_price.post_id AND pm_price.meta_key = '_price'
    LEFT JOIN wp_postmeta pm_regular_price ON p.ID = pm_regular_price.post_id AND pm_regular_price.meta_key = '_regular_price'
    LEFT JOIN wp_postmeta pm_stock ON p.ID = pm_stock.post_id AND pm_stock.meta_key = '_stock'
    LEFT JOIN wp_postmeta pm_thumb ON p.ID = pm_thumb.post_id AND pm_thumb.meta_key = '_thumbnail_id'
    LEFT JOIN wp_posts pm_thumb_img ON pm_thumb.meta_value = pm_thumb_img.ID
    LEFT JOIN wp_postmeta pm_rating ON p.ID = pm_rating.post_id AND pm_rating.meta_key = '_wc_average_rating'
    LEFT JOIN wp_postmeta pm_reviews ON p.ID = pm_reviews.post_id AND pm_reviews.meta_key = '_wc_review_count'
    LEFT JOIN wp_term_relationships tr ON p.ID = tr.object_id
    LEFT JOIN wp_term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'product_cat'
    LEFT JOIN wp_terms t ON tt.term_id = t.term_id
    WHERE p.post_type = 'product'
      AND p.post_status = 'publish'
      AND (pm_price.meta_value IS NOT NULL OR pm_regular_price.meta_value IS NOT NULL)
      AND COALESCE(pm_stock.meta_value, 100) > 0
    GROUP BY p.ID
    ORDER BY p.post_date DESC
    LIMIT 200
  `);

  return products.map(p => ({
    ...p,
    inventory: p.inventory || 100,
    image_url: p.image_url || undefined,
    category: p.category || undefined,
    rating: p.rating || 0,
    review_count: p.review_count || 0
  }));
}

// Enhanced confirmation handling
function checkForConfirmation(history: ChatMessage[], products: Product[]) {
  if (!history || history.length === 0) return null;

  const lastMessage = history[history.length - 1];
  if (lastMessage.role !== 'assistant') return null;

  // Check for buy confirmation
  const buyMatch = lastMessage.content.match(/Are you sure you want to buy\s+([^<\?]+)\?/i);
  if (buyMatch?.[1]) {
    const productName = buyMatch[1].trim();
    const product = products.find(p =>
      p.title.toLowerCase().includes(productName.toLowerCase())
    );
    return { type: 'buy', product };
  }

  // Check for cart confirmation
  const cartMatch = lastMessage.content.match(/Are you sure you want to add ([^<\?]+) to your cart\?/i);
  if (cartMatch?.[1]) {
    const productName = cartMatch[1].trim();
    const product = products.find(p =>
      p.title.toLowerCase().includes(productName.toLowerCase())
    );
    return { type: 'cart', product };
  }

  return null;
}

// Main API handler
export async function POST(req: NextRequest): Promise<NextResponse<AssistantResponse>> {
  let connection: mysql.PoolConnection | null = null;

  try {
    const body = await req.json();
    const { query, history, sessionId, userId } = requestSchema.parse(body);

    // Get database connection
    connection = await services.pool.getConnection();

    // Fetch products
    const products = await fetchProducts(connection);

    if (!products.length) {
      return NextResponse.json({
        reply: "I apologize, but we don't have any products available at the moment. Please check back later!",
        history: [
          ...(history || []),
          { role: 'user', content: query, timestamp: new Date().toISOString() },
          { role: 'assistant', content: "I apologize, but we don't have any products available at the moment. Please check back later!", timestamp: new Date().toISOString() }
        ]
      });
    }

    // Handle confirmations
    const confirmation = checkForConfirmation(history || [], products);
    if (confirmation && query.toLowerCase().includes('yes')) {
      const { type, product } = confirmation;

      if (!product) {
        return NextResponse.json({
          reply: "Sorry, I couldn't find that product anymore.",
          history: [
            ...(history || []),
            { role: 'user', content: query, timestamp: new Date().toISOString() },
            { role: 'assistant', content: "Sorry, I couldn't find that product anymore.", timestamp: new Date().toISOString() }
          ]
        });
      }

      if (type === 'buy') {
        return NextResponse.json({
          reply: `Perfect! Taking you to purchase ${product.title} now...`,
          redirect: `${config.baseUrl}/checkout/?add-to-cart=${product._id}`,
          product: product.title,
          history: [
            ...(history || []),
            { role: 'user', content: query, timestamp: new Date().toISOString() },
            { role: 'assistant', content: `Perfect! Taking you to purchase ${product.title} now...`, timestamp: new Date().toISOString() }
          ]
        });
      } else if (type === 'cart') {
        return NextResponse.json({
          reply: `Great! Added <b>${product.title}</b> to your cart successfully!`,
          addToCart: {
            id: product._id,
            title: product.title,
            price: product.price,
            image_url: product.image_url,
            quantity: 1
          },
          history: [
            ...(history || []),
            { role: 'user', content: query, timestamp: new Date().toISOString() },
            { role: 'assistant', content: `Great! Added <b>${product.title}</b> to your cart successfully!`, timestamp: new Date().toISOString() }
          ]
        });
      }
    }

    // Analyze user intent
    const userIntent = analyzeUserIntent(query);

    // Find matching products
    let matchingProducts = findMatchingProducts(query, products);

    // Apply filters
    if (userIntent.priceConstraint) {
      matchingProducts = matchingProducts.filter(p => p.price <= userIntent.priceConstraint!);
    }

    if (userIntent.priceRange && config.priceRanges[userIntent.priceRange]) {
      const [min, max] = config.priceRanges[userIntent.priceRange];
      matchingProducts = matchingProducts.filter(p => p.price >= min && p.price <= max);
    }

    // Handle direct action requests
    if (userIntent.isBuyRequest && matchingProducts.length === 1) {
      const product = matchingProducts[0];
      return NextResponse.json({
        reply: `I'll help you purchase the ${product.title} right away!`,
        redirect: `${config.baseUrl}/checkout/?add-to-cart=${product._id}`,
        history: [
          ...(history || []),
          { role: 'user', content: query, timestamp: new Date().toISOString() },
          { role: 'assistant', content: `I'll help you purchase the ${product.title} right away!`, timestamp: new Date().toISOString() }
        ]
      });
    }

    if (userIntent.isViewRequest && matchingProducts.length === 1) {
      const product = matchingProducts[0];
      return NextResponse.json({
        reply: `Here's the ${product.title} you requested!`,
        redirect: `${config.baseUrl}/product/${product.slug}`,
        history: [
          ...(history || []),
          { role: 'user', content: query, timestamp: new Date().toISOString() },
          { role: 'assistant', content: `Here's the ${product.title} you requested!`, timestamp: new Date().toISOString() }
        ]
      });
    }

    // Generate AI response
    const productList = matchingProducts.length > 0
      ? matchingProducts.slice(0, 6).map(p =>
        `ID: ${p._id}\nTitle: ${p.title}\nPrice: $${p.price}\nStock: ${p.inventory}\nDescription: ${p.description || 'No description'}\nCategory: ${p.category || 'General'}\nRating: ${p.rating}/5 (${p.review_count} reviews)\nImage: ${p.image_url || 'No image'}`
      ).join("\n\n")
      : "No products match the specific query.";

    const conversationContext = history
      ?.slice(-config.maxHistoryLength)
      ?.map(msg => `${msg.role === 'user' ? 'Customer' : 'Assistant'}: ${msg.content}`)
      ?.join('\n') || "New conversation";

    let contextualHint = "";
    if (userIntent.detectedEvent && matchingProducts.length > 0) {
      contextualHint = `\n**EVENT CONTEXT**: Customer mentioned "${userIntent.detectedEvent.replace('_', ' ')}" - highlight products perfect for this occasion.`;
    }

    if (userIntent.priceConstraint) {
      contextualHint += `\n**BUDGET**: Customer wants items under $${userIntent.priceConstraint}.`;
    }

    const prompt = `You are a helpful, knowledgeable shopping assistant for ${config.storeName}. Be conversational, friendly, and helpful.

**STRICT INVENTORY RULE: ONLY recommend products from the "AVAILABLE PRODUCTS" list below. NEVER suggest products not in this list.**

**CUSTOMER QUERY:** "${query}"
**DETECTED INTENT:** ${Object.entries(userIntent).filter(([_, v]) => v).map(([k, _]) => k).join(', ')}
${contextualHint}

**CONVERSATION HISTORY:**
${conversationContext}

**AVAILABLE PRODUCTS (Only show these):**
${productList}

**RESPONSE GUIDELINES:**
- If products available: Show them with the exact HTML format below
- If no matches: "I checked our inventory but don't currently have [requested item]. However, here are some great alternatives..." then show related products
- Be conversational and helpful
- Include ratings/reviews when available
- Suggest alternatives if original request not available

**EXACT HTML FORMAT:**
<ul>
  <li style='background:#fff; padding:16px; border-radius:12px; margin-bottom:16px; box-shadow:0 2px 8px rgba(0,0,0,0.08);'>
  <img src='IMAGE_URL' loading="lazy" style='width:100%; height:180px; object-fit:cover; border-radius:8px; margin-bottom:12px;' alt='PRODUCT_TITLE'/>
  <div style='margin-bottom:12px;'>
    <strong style='font-size:1.1rem; display:block; margin-bottom:4px;'>PRODUCT_TITLE</strong>
    <span style='color:#666; font-size:0.9rem;'>BRIEF_DESCRIPTION</span>
  </div>
  <div style='display:flex; justify-content:space-between; align-items:center;'>
    <span style='font-weight:600;'>$PRODUCT_PRICE</span>
    <div>
      <a href='${config.baseUrl}/product/PRODUCT_SLUG' style='color:#2563EB; text-decoration:none; margin-left:12px; font-weight:500;'>View</a>
      <a href='${config.baseUrl}/shop/?add-to-cart=PRODUCT_ID' style='color:#2563EB; text-decoration:none; margin-left:12px; font-weight:500;'>Add to Cart</a>
      <a href='${config.baseUrl}/checkout/?add-to-cart=PRODUCT_ID' style='color:#059669; text-decoration:none; margin-left:12px; font-weight:500;'>Buy</a>
    </div>
  </div>
</li>
</ul>

Remember: ONLY show products from the inventory list!`;

    const response = await services.openai.chat.completions.create({
      model: config.aiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 2000,
      presence_penalty: 0.1,
      frequency_penalty: 0.1
    });

    const reply = response.choices[0]?.message?.content || "I'm having trouble generating a response right now. Please try again in a moment.";

    // Generate suggestions for follow-up
    const suggestions = matchingProducts.length > 0 ? [
      "Show me more details about this product",
      "What other similar items do you have?",
      "Can you help me compare prices?",
      "Add this to my cart"
    ] : [
      "What products do you recommend?",
      "Show me your best sellers",
      "What's on sale right now?",
      "Help me find something specific"
    ];

    const newHistory = [
      ...(history || []),
      { role: 'user' as const, content: query, timestamp: new Date().toISOString() },
      { role: 'assistant' as const, content: reply, timestamp: new Date().toISOString() }
    ];

    return NextResponse.json({
      reply,
      history: newHistory,
      suggestions: suggestions.slice(0, 3),
      productCount: matchingProducts.length
    });

  } catch (err) {
    console.error("Shopping Assistant Error:", err);

    // More specific error handling
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          reply: "I couldn't understand your request. Please try rephrasing your question.",
          error: "Invalid request format"
        },
        { status: 400 }
      );
    }

    if (err instanceof Error && err.message.includes('timeout')) {
      return NextResponse.json(
        {
          reply: "I'm experiencing some delays right now. Please try again in a moment.",
          error: "Service timeout"
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        reply: "I'm having some technical difficulties. Please try again or contact support if this continues.",
        error: process.env.NODE_ENV === 'development' ? (err as Error).message : "Internal server error",
        history: (history as unknown as ChatMessage[]) || []
      },
      { status: 500 }
    );
  } finally {
    if (connection) {
      try {
        connection.release();
      } catch (releaseError) {
        console.error("Error releasing database connection:", releaseError);
      }
    }
  }
}

export async function GET(): Promise<NextResponse> {
  try {
    const connection = await services.pool.getConnection();
    await connection.ping();
    connection.release();

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '2.0.0'
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'unhealthy',
        error: (error as Error).message,
        timestamp: new Date().toISOString()
      },
      { status: 503 }
    );
  }
}
