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
}

const requestSchema = z.object({
  query: z.string().min(1).max(500),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional()
});

// Configuration
interface Config {
  maxHistoryLength: number;
  generalAiModel: "gpt-3.5-turbo";
  recommendationAiModel: "gpt-3.5-turbo";
  baseUrl: string;
  storeName: string;
  semanticKeywords: Record<string, string[]>;
  eventKeywords: Record<string, string[]>;
}

const config: Config = {
  maxHistoryLength: 10,
  generalAiModel: "gpt-3.5-turbo",
  recommendationAiModel: "gpt-3.5-turbo",
  baseUrl: "http://plugin.ijkstaging.com",
  storeName: process.env.STORE_NAME || "Plugin Store",

  // Semantic keyword mapping for better product matching
  semanticKeywords: {
    // Electronics & Printers
    'printer': ['printer', 'card printer', 'id printer', 'badge printer', 'printing machine'],
    'cards': ['card', 'id card', 'badge', 'access card', 'employee card'],
    'electronics': ['electronic', 'device', 'machine', 'equipment'],
    
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
    'gaming': ['console', 'controller', 'game', 'headset'],

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
  }
};

// Improved Phase Detection
function detectPhase(query: string, history: ChatMessage[]): 'general' | 'recommendation' {
  const lowerQuery = query.toLowerCase();

  // Greetings and general questions
  const generalKeywords = [
    'hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening',
    'who are you', 'what is this', 'about', 'help me', 'what can you do',
    'introduction', 'welcome', 'greetings', 'what is your name',
    'how are you', 'nice to meet you'
  ];

  // Store-related general questions
  const storeGeneralKeywords = [
    'what do you sell', 'what products do you have', 'tell me about your store',
    'what kind of store is this', 'what services do you offer'
  ];

  // Check for exact greetings or general questions
  if (generalKeywords.some(keyword => lowerQuery.includes(keyword))) {
    return 'general';
  }

  // Store general questions that should get quick answers
  if (storeGeneralKeywords.some(keyword => lowerQuery.includes(keyword))) {
    return 'general';
  }

  // Everything else goes to recommendation phase
  return 'recommendation';
}

function isDirectActionRequest(query: string): { action: 'buy' | 'view' | 'cart' | null; productName: string; vague: boolean } {
  const lowerQuery = query.toLowerCase().trim();

  // Vague buy requests (without product name)
  if (/^(buy|purchase)\s*(it|this|that)?$/i.test(lowerQuery)) {
    return { action: 'buy', productName: '', vague: true };
  }

  // Vague view requests
  if (/^(view)\s*(it|this|that)?$/i.test(lowerQuery)) {
    return { action: 'view', productName: '', vague: true };
  }

  // Vague cart requests
  if (/^(add to cart|cart)\s*(it|this|that)?$/i.test(lowerQuery)) {
    return { action: 'cart', productName: '', vague: true };
  }

  // Specific buy requests (with product name)
  if (/(buy|purchase)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(buy|purchase)\s+(.+)/i);
    const productName = match?.[2] || '';
    if (!['it', 'this', 'that'].includes(productName.trim())) {
      return { action: 'buy', productName, vague: false };
    }
  }

  // Specific view requests
  if (/(view|show me)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(view|show me|see)\s+(.+)/i);
    const productName = match?.[2] || '';
    if (!['it', 'this', 'that'].includes(productName.trim())) {
      return { action: 'view', productName, vague: false };
    }
  }

  // Specific cart requests
  if (/(add to cart|cart)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(add to cart|cart)\s+(.+)/i);
    const productName = match?.[2] || '';
    if (!['it', 'this', 'that'].includes(productName.trim())) {
      return { action: 'cart', productName, vague: false };
    }
  }

  return { action: null, productName: '', vague: false };
}

// Improved price range detection
function detectPriceRange(query: string): { min?: number; max?: number } | null {
  const lowerQuery = query.toLowerCase();
  
  // Under/below patterns
  const underPattern = /(under|below|less than|up to|maximum|max)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const underMatch = lowerQuery.match(underPattern);

  // Over/above patterns  
  const overPattern = /(over|above|more than|greater than|minimum|min)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const overMatch = lowerQuery.match(overPattern);

  // Between range patterns
  const betweenPattern = /between\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:and|to|-)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const betweenMatch = lowerQuery.match(betweenPattern);

  // Around/approximately patterns
  const aroundPattern = /(around|approximately|about)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i;
  const aroundMatch = lowerQuery.match(aroundPattern);

  if (betweenMatch) {
    const min = parseFloat(betweenMatch[1]);
    const max = parseFloat(betweenMatch[2]);
    return { min: Math.min(min, max), max: Math.max(min, max) };
  } else if (underMatch) {
    return { max: parseFloat(underMatch[2]) };
  } else if (overMatch) {
    return { min: parseFloat(overMatch[2]) };
  } else if (aroundMatch) {
    const price = parseFloat(aroundMatch[2]);
    return { min: price - 20, max: price + 20 };
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
  
  // Remove common filler words
  const fillerWords = ['is', 'there', 'any', 'do', 'you', 'have', 'show', 'me', 'some', 'find', 'looking', 'for', 'need', 'want'];
  const words = cleanQuery.split(/\s+/).filter(word => 
    word.length > 2 && !fillerWords.includes(word)
  );
  
  return words;
}

// Smart product matching function with improved price filtering
function findMatchingProducts(query: string, products: Product[]): Product[] {
  const lowerQuery = query.toLowerCase();
  const priceRange = detectPriceRange(query);
  const productKeywords = extractProductKeywords(query);

  console.log('Query:', query);
  console.log('Price range detected:', priceRange);
  console.log('Product keywords:', productKeywords);

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

    console.log(`Found ${filteredProducts.length} products matching price range`);
  }

  // Step 2: If no product keywords, return price-filtered results
  if (productKeywords.length === 0) {
    return filteredProducts.sort((a, b) => a.price - b.price).slice(0, 6);
  }

  // Step 3: Apply product keyword matching on price-filtered results
  const scoredProducts: Array<{ product: Product; score: number }> = [];

  filteredProducts.forEach(product => {
    const productText = `${product.title} ${product.description || ''} ${product.category || ''}`.toLowerCase();
    let score = 0;

    // Direct keyword matching
    productKeywords.forEach(keyword => {
      if (productText.includes(keyword)) {
        score += 20;
      }
    });

    // Semantic matching
    for (const [category, keywords] of Object.entries(config.semanticKeywords)) {
      const hasQueryKeyword = productKeywords.some(qkw => keywords.includes(qkw));
      const hasProductKeyword = keywords.some(keyword => productText.includes(keyword));
      
      if (hasQueryKeyword && hasProductKeyword) {
        score += 15;
      }
    }

    // Exact phrase matching (highest score)
    const queryPhrase = productKeywords.join(' ');
    if (productText.includes(queryPhrase)) {
      score += 50;
    }

    if (score > 0) {
      scoredProducts.push({ product, score });
    }
  });

  // Sort by score and return top results
  return scoredProducts
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(p => p.product);
}

// Check if query is asking to "show products" without specifics
function isVagueProductRequest(query: string): boolean {
  const lowerQuery = query.toLowerCase();
  const vaguePatterns = [
    /^show me (some )?products?$/,
    /^what products? do you have$/,
    /^(do you )?have any products?$/,
    /^show me what you have$/,
    /^what do you sell$/
  ];
  
  return vaguePatterns.some(pattern => pattern.test(lowerQuery.trim()));
}

// Initialize services
const initializeServices = () => {
  const requiredEnvVars = ['OPENAI_API_KEY', 'WP_DB_HOST', 'WP_DB_USER', 'WP_DB_PASSWORD', 'WP_DB_NAME'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
  }

  return {
    openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }),
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

export async function POST(req: NextRequest): Promise<NextResponse<AssistantResponse>> {
  let connection: mysql.PoolConnection | null = null;

  try {
    const body = await req.json();
    const { query, history } = requestSchema.parse(body);

    // Get database connection
    connection = await services.pool.getConnection();

    // Fetch products
    const [products] = await connection.query<any[]>(`
      SELECT 
        p.ID AS _id,
        p.post_title AS title,
        CAST(pm_price.meta_value AS DECIMAL(10,2)) AS price,
        100 AS inventory,
        p.post_content AS description,
        p.post_name AS slug,
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
    `);

    if (!products.length) {
      return NextResponse.json({
        reply: "Currently we don't have any products available. Please check back later.",
        history: history || [],
        phase: 'general'
      });
    }

    // Map to consistent product structure
    const mappedProducts: Product[] = products.map(p => ({
      ...p,
      inventory: 100,
      image_url: p.image_url || undefined,
      category: p.category || undefined
    }));

    // Handle confirmation responses for direct actions
    const directAction = isDirectActionRequest(query);

    // Check for pending confirmations and actions
    let pendingConfirmation = null;
    let pendingAction = null;
    
    if (history && history.length > 0) {
      const lastMessage = history[history.length - 1].content;

      // Buy confirmation
      const buyMatch = lastMessage.match(/Are you sure you want to buy\s+([^?]+)\?/i);
      if (buyMatch) {
        pendingConfirmation = { type: 'buy', product: buyMatch[1].trim() };
      }

      // View confirmation
      const viewMatch = lastMessage.match(/Are you sure you want to view\s+([^?]+)\?/i);
      if (viewMatch) {
        pendingConfirmation = { type: 'view', product: viewMatch[1].trim() };
      }

      // Cart confirmation
      const cartMatch = lastMessage.match(/Are you sure you want to add\s+([^?]+)\s+to your cart\?/i);
      if (cartMatch) {
        pendingConfirmation = { type: 'cart', product: cartMatch[1].trim() };
      }

      // Pending action (waiting for product name)
      const buyActionMatch = lastMessage.match(/What would you like to buy\?/i);
      if (buyActionMatch) {
        pendingAction = { type: 'buy' };
      }

      const viewActionMatch = lastMessage.match(/What would you like to view\?/i);
      if (viewActionMatch) {
        pendingAction = { type: 'view' };
      }

      const cartActionMatch = lastMessage.match(/What would you like to add to cart\?/i);
      if (cartActionMatch) {
        pendingAction = { type: 'cart' };
      }
    }

    // Handle pending actions (user provided product name after vague request)
    if (pendingAction && !pendingConfirmation) {
      const matchingProducts = findMatchingProducts(query, mappedProducts);
      
      if (matchingProducts.length === 0) {
        return NextResponse.json({
          reply: `Sorry, I couldn't find "${query}". Could you try a different product name or be more specific?`,
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: `Sorry, I couldn't find "${query}". Could you try a different product name or be more specific?` }
          ],
          phase: 'recommendation'
        });
      }

      const product = matchingProducts[0];
      let confirmationMessage = '';

      if (pendingAction.type === 'buy') {
        confirmationMessage = `Are you sure you want to buy ${product.title}?`;
      } else if (pendingAction.type === 'view') {
        confirmationMessage = `Are you sure you want to view ${product.title}?`;
      } else if (pendingAction.type === 'cart') {
        confirmationMessage = `Are you sure you want to add ${product.title} to your cart?`;
      }

      return NextResponse.json({
        reply: confirmationMessage,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: confirmationMessage }
        ],
        phase: 'recommendation'
      });
    }

    // Handle confirmation responses
    if (pendingConfirmation && (query.toLowerCase().includes('yes') || query.toLowerCase().includes('yeah') || query.toLowerCase().includes('sure') || query.toLowerCase().includes('ok'))) {
      const product = mappedProducts.find(p =>
        p.title.toLowerCase().includes(pendingConfirmation.product.toLowerCase())
      );

      if (!product) {
        return NextResponse.json({
          reply: "Sorry, I couldn't find that product anymore.",
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: "Sorry, I couldn't find that product anymore." }
          ],
          phase: 'recommendation'
        });
      }

      if (pendingConfirmation.type === 'buy') {
        return NextResponse.json({
          reply: `Redirecting you to purchase ${product.title}...`,
          redirect: `${config.baseUrl}/checkout/?add-to-cart=${product._id}`,
          product: product.title,
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: `Redirecting you to purchase ${product.title}...` }
          ],
          phase: 'recommendation'
        });
      } else if (pendingConfirmation.type === 'view') {
        return NextResponse.json({
          reply: `Taking you to ${product.title} page...`,
          redirect: `${config.baseUrl}/product/${product.slug}`,
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: `Taking you to ${product.title} page...` }
          ],
          phase: 'recommendation'
        });
      } else if (pendingConfirmation.type === 'cart') {
        return NextResponse.json({
          reply: `Added <b>${product.title}</b> to your cart!`,
          addToCart: {
            id: product._id,
            title: product.title,
            price: product.price,
            image_url: product.image_url
          },
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: `Added <b>${product.title}</b> to your cart!` }
          ],
          phase: 'recommendation'
        });
      }
    }

    // Detect current phase
    const currentPhase = detectPhase(query, history || []);

    // PHASE 1: GENERAL QUESTIONS - Quick responses
    if (currentPhase === 'general') {
      const lowerQuery = query.toLowerCase();
      let reply = '';

      // Greetings
      if (lowerQuery.includes('hello') || lowerQuery.includes('hi') || lowerQuery.includes('hey')) {
        reply = `Hello! Welcome to ${config.storeName}. I'm here to help you find the perfect products. What are you looking for today?`;
      }
      // About store
      else if (lowerQuery.includes('what do you sell') || lowerQuery.includes('what products')) {
        reply = `We sell a variety of products including card printers, electronics, and more. What specific type of product are you interested in?`;
      }
      // General help
      else if (lowerQuery.includes('help') || lowerQuery.includes('what can you do')) {
        reply = `I can help you find products, check prices, and answer questions about our inventory. Just tell me what you're looking for!`;
      }
      // Default general response
      else {
        reply = `Hi there! I'm your shopping assistant at ${config.storeName}. I can help you find products, compare prices, and answer any questions. What can I help you find today?`;
      }

      return NextResponse.json({
        reply,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: reply }
        ],
        phase: 'general'
      });
    }

    // Handle vague product requests
    if (isVagueProductRequest(query)) {
      return NextResponse.json({
        reply: "I'd be happy to help you find what you need! Could you tell me what type of product you're looking for? For example: electronics, printers, or anything specific you have in mind?",
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: "I'd be happy to help you find what you need! Could you tell me what type of product you're looking for? For example: electronics, printers, or anything specific you have in mind?" }
        ],
        phase: 'recommendation'
      });
    }

    // Handle direct action requests
    if (directAction.action) {
      // Vague requests (no product name)
      if (directAction.vague) {
        let reply = '';
        if (directAction.action === 'buy') {
          reply = 'What would you like to buy?';
        } else if (directAction.action === 'view') {
          reply = 'What would you like to view?';
        } else if (directAction.action === 'cart') {
          reply = 'What would you like to add to cart?';
        }

        return NextResponse.json({
          reply,
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: reply }
          ],
          phase: 'recommendation'
        });
      }
      
      // Specific requests (with product name)
      if (directAction.productName) {
        const matchingProducts = findMatchingProducts(directAction.productName, mappedProducts);

        if (matchingProducts.length === 0) {
          return NextResponse.json({
            reply: `I'm sorry, we don't currently have "${directAction.productName}" in our inventory. Is there anything else I can help you find?`,
            history: [
              ...(history || []),
              { role: 'user', content: query },
              { role: 'assistant', content: `I'm sorry, we don't currently have "${directAction.productName}" in our inventory. Is there anything else I can help you find?` }
            ],
            phase: 'recommendation'
          });
        }

        const product = matchingProducts[0];
        let confirmationMessage = '';

        if (directAction.action === 'buy') {
          confirmationMessage = `Are you sure you want to buy ${product.title}?`;
        } else if (directAction.action === 'view') {
          confirmationMessage = `Are you sure you want to view ${product.title}?`;
        } else if (directAction.action === 'cart') {
          confirmationMessage = `Are you sure you want to add ${product.title} to your cart?`;
        }

        return NextResponse.json({
          reply: confirmationMessage,
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: confirmationMessage }
          ],
          phase: 'recommendation'
        });
      }
    }

    // PHASE 2: PRODUCT RECOMMENDATION
    const matchingProducts = findMatchingProducts(query, mappedProducts);
    const priceRange = detectPriceRange(query);
    const productKeywords = extractProductKeywords(query);

    // Handle the case where no products match
    if (matchingProducts.length === 0) {
      let reply = '';
      
      if (priceRange && productKeywords.length > 0) {
        // User asked for specific product with price range
        const priceText = priceRange.max ? `under $${priceRange.max}` : `over $${priceRange.min}`;
        reply = `Sorry, we don't have any ${productKeywords.join(' ')} ${priceText}. Would you like to see similar products in a different price range?`;
      } else if (priceRange) {
        // User asked only for price range
        const priceText = priceRange.max ? `under $${priceRange.max}` : `over $${priceRange.min}`;
        reply = `Sorry, we don't have any products ${priceText}. Our products start from a different price range. Would you like to see what's available?`;
      } else {
        // User asked for specific product without price
        reply = `Sorry, we don't have "${productKeywords.join(' ')}" in our current inventory. Could you try describing what you need differently, or would you like to see similar products?`;
      }

      return NextResponse.json({
        reply,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: reply }
        ],
        phase: 'recommendation'
      });
    }

    // Create response with matching products
    let reply = '';
    
    if (priceRange && productKeywords.length > 0) {
      // User asked for specific product with price range
      const priceText = priceRange.max ? `under $${priceRange.max}` : `over $${priceRange.min}`;
      reply = `Yes! Here are the ${productKeywords.join(' ')} products we have ${priceText}:\n\n`;
    } else if (priceRange) {
      // User asked only for price range
      const priceText = priceRange.max ? `under $${priceRange.max}` : `over $${priceRange.min}`;
      reply = `Yes! Here are our products ${priceText}:\n\n`;
    } else {
      // User asked for specific product without price
      reply = `Great! Here are the ${productKeywords.join(' ')} products we have:\n\n`;
    }

    // Add product HTML
    const productHTML = matchingProducts.map(product => `
<ul style='list-style:none;'>
  <li style='background:#fff; padding:16px; border:1px solid #eee; border-radius:12px; margin-bottom:16px; box-shadow:0 2px 8px rgba(0,0,0,0.05); transition:transform 0.2s;'>
  <img src='${product.image_url || ''}' loading="lazy" style='width:100%; height:180px; object-fit:cover; border-radius:8px; margin-bottom:12px;' alt='${product.title}'/>
  <strong style='display:block; font-size:16px; margin-bottom:6px;'>${product.title}</strong>
  <p style='color:#666; font-size:14px; margin-bottom:12px;'>${product.description ? product.description.substring(0, 80) + (product.description.length > 80 ? '...' : '') : 'Premium quality product'}</p>
  <strong style='display:block; font-size:18px; margin-bottom:12px;'>$${product.price}</strong>
  <div style='display:flex; gap:8px; flex-wrap:wrap;'>
    <a href='${config.baseUrl}/product/${product.slug}' style='background:#f8fafc; color:#2563EB; padding:8px 12px; border-radius:6px; text-decoration:none; border:1px solid #e2e8f0; font-size:14px;'>View</a>
    <a href='${config.baseUrl}/checkout/?add-to-cart=${product._id}' style='background:#2563EB; color:#fff; padding:8px 12px; border-radius:6px; text-decoration:none; font-size:14px;'>Buy Now</a>
    <a href='${config.baseUrl}/shop/?add-to-cart=${product._id}' style='background:#059669; color:#fff; padding:8px 12px; border-radius:6px; text-decoration:none; font-size:14px;'>Add to Cart</a>
  </div>
</li>
</ul>`).join('');

    reply += productHTML;

    // Add helpful closing message
    if (matchingProducts.length > 0) {
      reply += `\n\nNeed help choosing or have questions about any of these products? Just ask!`;
    }

    return NextResponse.json({
      reply,
      history: [
        ...(history || []),
        { role: 'user', content: query },
        { role: 'assistant', content: reply }
      ],
      phase: 'recommendation'
    });

  } catch (err) {
    console.error("Customer Assistant Error:", err);
    return NextResponse.json(
      {
        reply: "Sorry, I encountered an error. Please try again.",
        error: (err as Error).message,
        phase: 'general'
      },
      { status: 500 }
    );
  } finally {
    if (connection) connection.release();
  }
}
