import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import mysql from 'mysql2/promise';
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

// Product Interface (matches SQLite version)
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
}

const requestSchema = z.object({
  query: z.string().min(1).max(500),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional()
});

// Enhanced Configuration with semantic keywords
interface Config {
  maxHistoryLength: number;
  aiModel: "gpt-3.5-turbo" | "gpt-4";
  baseUrl: string;
  viewKeywords: string[];
  redirectionKeywords: string[];
  storeName?: string;
  semanticKeywords: Record<string, string[]>;
  eventKeywords: Record<string, string[]>;
}

const config: Config = {
  maxHistoryLength: 5,
  aiModel: "gpt-3.5-turbo",
  baseUrl: "http://plugin.ijkstaging.com",
  viewKeywords: [
    'show me', 'view', 'navigate to', 'head to', 'go to',
    'see', 'see more', 'see details', 'details', 'details of',
    'learn more', 'open', 'visit', 'explore', 'look at',
    'take me to', 'redirect me to', 'check out', 'move to',
    'click here', 'head over to', 'take a look at', 'take me',
    'search for', 'access', 'load', 'jump to', 'browse'
  ],
  redirectionKeywords: [
    'buy', 'buy now', 'purchase', 'order', 'checkout'
  ],
  storeName: process.env.STORE_NAME || "our store",
  
  // Semantic keyword mapping for better product matching
  semanticKeywords: {
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
    
    // Electronics
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

// Enhanced helper functions
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Smart product matching function
function findMatchingProducts(query: string, products: Product[]): Product[] {
  const lowerQuery = query.toLowerCase();
  // Use a tuple array to keep track of scores without mutating Product
  const scoredProducts: Array<{ product: Product; score: number }> = [];
  const queryWords = lowerQuery.split(/\s+/);

  // 1. Direct title/description matching (highest priority)
  products.forEach(product => {
    const productText = `${product.title} ${product.description || ''} ${product.category || ''}`.toLowerCase();

    // Exact phrase match
    if (productText.includes(lowerQuery)) {
      scoredProducts.push({ product, score: 100 });
      return;
    }

    // Word matching
    const matchingWords = queryWords.filter(word =>
      word.length > 2 && productText.includes(word)
    );

    if (matchingWords.length > 0) {
      const score = (matchingWords.length / queryWords.length) * 80;
      if (score > 30) {
        scoredProducts.push({ product, score });
      }
    }
  });

  // 2. Semantic keyword matching
  for (const [category, keywords] of Object.entries(config.semanticKeywords)) {
    for (const keyword of keywords) {
      if (lowerQuery.includes(keyword)) {
        products.forEach(product => {
          const productText = `${product.title} ${product.description || ''} ${product.category || ''}`.toLowerCase();
          const categoryMatches = keywords.some(k => productText.includes(k));
          if (categoryMatches && !scoredProducts.find(p => p.product._id === product._id)) {
            scoredProducts.push({ product, score: 60 });
          }
        });
      }
    }
  }

  // 3. Event-based matching
  for (const [event, items] of Object.entries(config.eventKeywords)) {
    if (lowerQuery.includes(event) || lowerQuery.includes(event.replace('_', ' '))) {
      products.forEach(product => {
        const productText = `${product.title} ${product.description || ''} ${product.category || ''}`.toLowerCase();
        const itemMatches = items.some(item => productText.includes(item.toLowerCase()));
        if (itemMatches && !scoredProducts.find(p => p.product._id === product._id)) {
          scoredProducts.push({ product, score: 70 });
        }
      });
    }
  }

  // Remove duplicates and sort by score
  const uniqueProducts = Array.from(
    new Map(scoredProducts.map(p => [p.product._id, p])).values()
  ).sort((a, b) => b.score - a.score);

  return uniqueProducts.slice(0, 6).map(p => p.product); // Limit to top 6 matches
}

// Enhanced context analysis
function analyzeUserIntent(query: string): {
  isViewRequest: boolean;
  isBuyRequest: boolean;
  isAddToCartRequest: boolean;
  isGeneralQuery: boolean;
  extractedProductName: string;
  detectedEvent: string | null;
  priceConstraint: number | null;
} {
  const lowerQuery = query.toLowerCase();
  
  // Intent detection with improved patterns
  const isViewRequest = /(show|view|see|display|look at|find|search for|what.*do you have|any.*available)/i.test(lowerQuery);
  const isBuyRequest = /(buy|purchase|order|checkout|get me)/i.test(lowerQuery);
  const isAddToCartRequest = /(add to cart|put in cart|cart)/i.test(lowerQuery);
  const isGeneralQuery = /(help|suggest|recommend|need|looking for|want)/i.test(lowerQuery);
  
  // Extract product name with better patterns
  let extractedProductName = '';
  const productPatterns = [
    /(?:for|any|some|a|the)\s+([a-zA-Z\s]+?)(?:\s+(?:for|to|that)|\?|$)/i,
    /(?:buy|show|find|need|want|looking for)\s+(?:me\s+)?(?:a|an|some|the)?\s*([a-zA-Z\s]+?)(?:\s+(?:for|to|that)|\?|$)/i,
    /([a-zA-Z\s]+?)(?:\s+(?:available|in stock|for sale))/i
  ];
  
  for (const pattern of productPatterns) {
    const match = lowerQuery.match(pattern);
    if (match && match[1]) {
      extractedProductName = match[1].trim();
      break;
    }
  }
  
  // Event detection
  let detectedEvent: string | null = null;
  for (const event of Object.keys(config.eventKeywords)) {
    if (lowerQuery.includes(event) || lowerQuery.includes(event.replace('_', ' '))) {
      detectedEvent = event;
      break;
    }
  }
  
  // Price constraint extraction
  let priceConstraint: number | null = null;
  const priceMatch = lowerQuery.match(/(?:under|below|less than|cheaper than|max|maximum|<=?)\s*\$?([0-9]+)/i);
  if (priceMatch?.[1]) {
    priceConstraint = parseFloat(priceMatch[1]);
  }
  
  return {
    isViewRequest,
    isBuyRequest,
    isAddToCartRequest,
    isGeneralQuery,
    extractedProductName,
    detectedEvent,
    priceConstraint
  };
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

    // Fetch products with enhanced query to get more product details
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
      GROUP BY p.ID, p.post_title, pm_price.meta_value, p.post_content, p.post_name, pm_thumb_img.guid
    `);

    if (!products.length) {
      return NextResponse.json({
        reply: "Currently we don't have any products available. Please check back later.",
        history: history || []
      });
    }

    // Map to consistent product structure
    const mappedProducts: Product[] = products.map(p => ({
      ...p,
      inventory: 100, 
      image_url: p.image_url || undefined,
      category: p.category || undefined
    }));

    // Handle existing confirmation logic...
    let confirmationProductId: string | null = null;
    if (history && history.length > 0) {
      const lastAssistantMessage = history[history.length - 1].content;
      const match = lastAssistantMessage.match(/Are you sure you want to buy\s+([^<\?]+)\?/i);
      if (match?.[1]) {
        const productName = match[1].trim();
        const product = mappedProducts.find(p =>
          p.title.toLowerCase().includes(productName.toLowerCase())
        );
        if (product) confirmationProductId = product._id;
      }
    }

    // Handle buy confirmation
    if (confirmationProductId && query.toLowerCase().includes('yes')) {
      const product = mappedProducts.find(p => p._id === confirmationProductId);
      if (!product) {
        return NextResponse.json({
          reply: "Sorry, I couldn't find that product anymore.",
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: "Sorry, I couldn't find that product anymore." }
          ]
        });
      }

      return NextResponse.json({
        reply: `Redirecting you to purchase ${product.title}...`,
        redirect: `${config.baseUrl}/checkout/?add-to-cart=${product._id}`,
        product: product.title,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: `Redirecting you to purchase ${product.title}...` }
        ]
      });
    }

    // Handle add to cart confirmation
    let confirmationAddToCartProductId: string | null = null;
    if (history && history.length > 0) {
      const lastAssistantMessage = history[history.length - 1].content;
      const match = lastAssistantMessage.match(/Are you sure you want to add ([^<\?]+) to your cart\?/i);
      if (match?.[1]) {
        const productName = match[1].trim();
        const product = mappedProducts.find(p =>
          p.title.toLowerCase().includes(productName.toLowerCase())
        );
        if (product) confirmationAddToCartProductId = product._id;
      }
    }

    if (confirmationAddToCartProductId && query.toLowerCase().includes('yes')) {
      const product = mappedProducts.find(p => p._id === confirmationAddToCartProductId);
      if (!product) {
        return NextResponse.json({
          reply: "Sorry, I couldn't find that product anymore.",
          history: [
            ...(history || []),
            { role: 'user', content: query },
            { role: 'assistant', content: "Sorry, I couldn't find that product anymore." }
          ]
        });
      }

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
        ]
      });
    }

    // Enhanced intent analysis
    const userIntent = analyzeUserIntent(query);
    
    // Smart product matching
    let matchingProducts = findMatchingProducts(query, mappedProducts);
    
    // Apply price filter if detected
    if (userIntent.priceConstraint) {
      matchingProducts = matchingProducts.filter(p => p.price <= userIntent.priceConstraint!);
    }

    // Handle specific action requests with matched products
    if (userIntent.isBuyRequest && matchingProducts.length > 0) {
      const product = matchingProducts[0];
      return NextResponse.json({
        reply: `I'll help you purchase ${product.title}...`,
        redirect: `${config.baseUrl}/checkout/?add-to-cart=${product._id}`,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: `I'll help you purchase ${product.title}...` }
        ]
      });
    }

    if (userIntent.isViewRequest && matchingProducts.length > 0) {
      const product = matchingProducts[0];
      return NextResponse.json({
        reply: `I'll take you to the ${product.title} page...`,
        redirect: `${config.baseUrl}/product/${product.slug}`,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: `I'll take you to the ${product.title} page...` }
        ]
      });
    }

    if (userIntent.isAddToCartRequest && matchingProducts.length > 0) {
      const product = matchingProducts[0];
      return NextResponse.json({
        reply: `Adding ${product.title} to your cart...`,
        redirect: `${config.baseUrl}/shop/?add-to-cart=${product._id}`,
        history: [
          ...(history || []),
          { role: 'user', content: query },
          { role: 'assistant', content: `Adding ${product.title} to your cart...` }
        ]
      });
    }

    // Enhanced AI prompt with better context and instructions
    const productList = matchingProducts.length > 0
      ? matchingProducts.map(p => 
          `ID: ${p._id}\nTitle: ${p.title}\nPrice: ${p.price}\nStock: ${p.inventory}\nDescription: ${p.description}\nCategory: ${p.category || 'General'}\nImage: ${p.image_url}`
        ).join("\n\n")
      : mappedProducts.slice(0, 6).map(p =>
          `ID: ${p._id}\nTitle: ${p.title}\nPrice: ${p.price}\nStock: ${p.inventory}\nDescription: ${p.description}\nCategory: ${p.category || 'General'}\nImage: ${p.image_url}`
        ).join("\n\n");

    const conversationContext = history
      ?.slice(-config.maxHistoryLength)
      ?.map(msg => `${msg.role === 'user' ? 'Customer' : 'Assistant'}: ${msg.content}`)
      ?.join('\n') || "No previous conversation";

    // Create context-aware prompt with strict inventory limitations
    let contextualHint = "";
    if (userIntent.detectedEvent && matchingProducts.length > 0) {
      contextualHint = `\n**CONTEXT NOTE**: Customer mentioned "${userIntent.detectedEvent.replace('_', ' ')}" - focus on the available products that would work for this occasion.`;
    }

    const prompt = `
You are a helpful shopping assistant for ${config.storeName}. Your primary rule is to ONLY recommend products that exist in the provided inventory.

**CRITICAL RULES - MUST FOLLOW:**
1. **ONLY show products from the "AVAILABLE PRODUCTS" list below**
2. **NEVER mention or suggest products not in the list**
3. **NEVER make up product names, even if they seem relevant**
4. **If no matching products exist, clearly state this**

**CUSTOMER QUERY:** "${query}"
**INTENT:** ${userIntent.isViewRequest ? 'Browsing' : userIntent.isBuyRequest ? 'Ready to buy' : userIntent.isAddToCartRequest ? 'Add to cart' : 'General inquiry'}
**PRICE LIMIT:** ${userIntent.priceConstraint ? `${userIntent.priceConstraint}` : 'None'}
${contextualHint}

**PREVIOUS CONVERSATION:**  
${conversationContext}  

**AVAILABLE PRODUCTS (ONLY show these):**  
${productList}  

**CONVERSATION CONTINUITY INSTRUCTIONS:**
- Continue the conversation as if you are chatting back and forth with the customer.
- Reference the customer's last message and your previous response for context.
- Avoid repeating the same greetings or closings.
- If the customer asks to 'show me' or 'see more', treat it as a follow-up and show more products or alternatives, referencing what was discussed before.

**GENERAL QUESTION HANDLING:**
- If the customer greets you (e.g., 'hi', 'hello'), greet them back and offer assistance.
- If the customer asks for help, explain what you can do and how you can assist with product recommendations or questions.
- If the customer asks something unrelated to shopping or products, politely explain your role as a shopping assistant and guide them back to shopping-related topics.
- Always keep your responses warm, friendly, and context-aware.

**RESPONSE INSTRUCTIONS:**
- If products are available: Show them using the HTML format below
- If NO products match: Say "I checked our inventory but we don't currently have [what they asked for]. However, we do have [mention other available products that might interest them]"
- Be helpful but honest about what's actually available
- Use warm, conversational tone

**HTML FORMAT (use exactly this):**
<ul>
  <li style='background:#f9f9f9; padding:16px; border:1px solid #ddd; border-radius:8px; margin-bottom:12px'>
    <img src='IMAGE_URL' loading="lazy" style='max-width:100%; height:auto; max-height:150px; margin-bottom:8px; border-radius:4px;' alt='PRODUCT_TITLE'/><br/>
    <strong>PRODUCT_TITLE</strong> - BRIEF_DESCRIPTION<br/>
    Price: $PRODUCT_PRICE<br/>
    <a href='${config.baseUrl}/product/PRODUCT_SLUG' target='_blank' style='background:#2563EB; margin: 8px; color:#fff; padding:6px 12px; border-radius:6px; text-decoration:none; margin-right:8px; display:inline-block;'>View Product</a>
    <a href='${config.baseUrl}/checkout/?add-to-cart=PRODUCT_ID' target='_blank' style='background:#059669; margin: 8px; color:#fff; padding:6px 12px; border-radius:6px; text-decoration:none; display:inline-block;'>Buy Now</a>
    <a href='${config.baseUrl}/shop/?add-to-cart=PRODUCT_ID' target='_blank' style='background:#916f10; margin: 8px; color:#fff; padding:6px 12px; border-radius:6px; text-decoration:none; display:inline-block;'>Add to Cart</a>
  </li>
</ul>

Remember: ONLY recommend what's actually in stock!`;

    const res = await services.openai.chat.completions.create({
      model: config.aiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 1500
    });

    const reply = res.choices[0]?.message?.content || "I couldn't generate a response. Please try again.";
    
    return NextResponse.json({
      reply,
      history: [
        ...(history || []),
        { role: 'user', content: query },
        { role: 'assistant', content: reply }
      ]
    });

  } catch (err) {
    console.error("Customer Assistant Error:", err);
    return NextResponse.json(
      {
        reply: "Sorry, I encountered an error. Please try again.",
        error: (err as Error).message
      },
      { status: 500 }
    );
  } finally {
    if (connection) connection.release();
  }
}
