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

// Phase Detection Functions
function detectPhase(query: string, history: ChatMessage[]): 'general' | 'recommendation' {
  const lowerQuery = query.toLowerCase();

  // Phase 1: General Questions
  const generalKeywords = [
    'hi', 'hello', 'hey', 'who are you', 'what is this', 'about', 'store',
    'help', 'what do you sell', 'what products', 'what can you do',
    'introduction', 'welcome', 'greetings', 'what is your name'
  ];

  // If it's a greeting or very general question  
  if (generalKeywords.some(keyword => lowerQuery.includes(keyword))) {
    return 'general';
  }

  // If user is looking for products (even vaguely)
  if (lowerQuery.includes('looking for') || lowerQuery.includes('need') ||
    lowerQuery.includes('want') || lowerQuery.includes('products')) {
    return 'recommendation';
  }

  // Everything else goes to recommendation phase
  return 'recommendation';
}

function isDirectActionRequest(query: string): { action: 'buy' | 'view' | 'cart' | null; productName: string } {
  const lowerQuery = query.toLowerCase();

  // Buy request
  if (/(buy|purchase)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(buy|purchase)\s+(.+)/i);
    return { action: 'buy', productName: match?.[2] || '' };
  }

  // View request
  if (/(view)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(view|see|show)\s+(.+)/i);
    return { action: 'view', productName: match?.[2] || '' };
  }

  // Add to cart request
  if (/(add to cart|cart)\s+(.+)/i.test(lowerQuery)) {
    const match = lowerQuery.match(/(add to cart|cart)\s+(.+)/i);
    return { action: 'cart', productName: match?.[2] || '' };
  }

  return { action: null, productName: '' };
}

// Smart product matching function
function findMatchingProducts(query: string, products: Product[]): Product[] {
  const lowerQuery = query.toLowerCase();
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

  return uniqueProducts.slice(0, 6).map(p => p.product);
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

    // Check for pending confirmations
    let pendingConfirmation = null;
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
    }

    // Handle confirmation responses
    if (pendingConfirmation && query.toLowerCase().includes('yes')) {
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

    // PHASE 1: GENERAL QUESTIONS
    if (currentPhase === 'general') {
      const generalPrompt = `
You are a friendly customer service assistant for ${config.storeName}. 

**INSTRUCTIONS:**
- Keep responses SHORT and FRIENDLY (1-2 sentences max)
- Answer general questions about the store quickly
- If asked about products, mention you can help them find what they need
- Be welcoming and helpful
- Don't list specific products yet

**CUSTOMER QUERY:** "${query}"

**STORE INFO:**
- Store Name: ${config.storeName}
- We sell mostly card printers and electronics
- We help customers find exactly what they need through personalized assistance

Respond naturally and briefly to their query.`;

      const res = await services.openai.chat.completions.create({
        model: config.generalAiModel,
        messages: [{ role: "user", content: generalPrompt }],
        temperature: 0.3,
        max_tokens: 150
      });

      const reply = res.choices[0]?.message?.content || "Hello! I'm here to help you find what you need.";

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

    // Handle direct action requests with confirmation
    if (directAction.action && directAction.productName) {
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

    // PHASE 2: PRODUCT RECOMMENDATION (combined with inquiry)
    const matchingProducts = findMatchingProducts(query, mappedProducts);
    const conversationContext = history
      ?.slice(-config.maxHistoryLength)
      ?.map(msg => `${msg.role === 'user' ? 'Customer' : 'Assistant'}: ${msg.content}`)
      ?.join('\n') || "No previous conversation";

    const productList = matchingProducts.length > 0
      ? matchingProducts.map(p =>
        `ID: ${p._id}\nTitle: ${p.title}\nPrice: $${p.price}\nDescription: ${p.description}\nCategory: ${p.category || 'General'}\nImage: ${p.image_url || 'No image'}\nSlug: ${p.slug}`
      ).join("\n\n")
      : "No matching products found";

    const recommendationPrompt = `
You are a helpful shopping assistant for ${config.storeName}. Your goal is to have a natural conversation while helping customers find products.

**IMPORTANT RULES:**
1. Be conversational and friendly
2. If the query is unclear, ask ONE clarifying question at a time
3. If products match, show them in the HTML format below
4. If no products match, apologize and ask if they'd like alternatives
5. For product questions, answer accurately based on the product details
6. Maintain context from previous messages in the conversation

**CUSTOMER QUERY:** "${query}"

**CONVERSATION HISTORY:**
${conversationContext}

**AVAILABLE PRODUCTS:**
${productList}

**RESPONSE GUIDELINES:**
${matchingProducts.length > 0 ? `
- Show matching products using the HTML format below
- Briefly explain why these products might be relevant
- Keep the tone friendly and helpful
- If multiple products match, show the top 3 most relevant
` : `
- Apologize that we don't have exactly what they're looking for
- Ask if they'd like to see alternatives or describe what they need differently
- If they mentioned an event (birthday, wedding etc.), suggest related items
`}

**HTML FORMAT (use exactly this for each product):**
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

**EXAMPLES:**
- If customer asks "Do you have blue chairs?" and we have matches:
  "Yes! Here are some blue chairs we have in stock: [HTML product list]"

- If customer asks "Do you have blue chairs?" and we don't have matches:
  "We don't have blue chairs currently, but we have these similar options: [HTML product list] 
   Or would you like me to suggest something different?"

- If customer asks vaguely "I need something for my living room":
  "What type of items are you looking for? Furniture, decor, lighting? And do you have any style preferences?"

- If customer asks about product details:
  "The [Product Name] features [accurate details from description]. Would you like to see more options?"`;

    const res = await services.openai.chat.completions.create({
      model: config.recommendationAiModel,
      messages: [{ role: "user", content: recommendationPrompt }],
      temperature: 0.7,
      max_tokens: 1500
    });

    const reply = res.choices[0]?.message?.content || "I'd be happy to help you find what you need.";

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
