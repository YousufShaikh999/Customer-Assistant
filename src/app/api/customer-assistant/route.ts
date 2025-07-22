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

// Configuration (matches SQLite version)
interface Config {
  maxHistoryLength: number;
  aiModel: "gpt-3.5-turbo" | "gpt-4";
  baseUrl: string;
  viewKeywords: string[];
  redirectionKeywords: string[];
  storeName?: string;
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
  storeName: process.env.STORE_NAME || "our store"
};

// Helper functions
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    pm_thumb_img.guid AS image_url
  FROM wp_posts p
  LEFT JOIN wp_postmeta pm_price ON p.ID = pm_price.post_id AND pm_price.meta_key = '_price'
  LEFT JOIN wp_postmeta pm_thumb ON p.ID = pm_thumb.post_id AND pm_thumb.meta_key = '_thumbnail_id'
  LEFT JOIN wp_posts pm_thumb_img ON pm_thumb.meta_value = pm_thumb_img.ID
  WHERE p.post_type = 'product'
    AND p.post_status = 'publish'
    AND pm_price.meta_value IS NOT NULL
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
      inventory: 100,  // Default value
      image_url: p.image_url || undefined
    }));

    // Confirmation handling (buy flow)
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

    // Add to cart confirmation handling
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

    // Handle add to cart confirmation
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

    // Extract price constraints
    let priceConstraint: number | null = null;
    const priceMatch = query.match(/(?:under|below|less than|cheaper than|<=?)\s*\$?([0-9]+)/i);
    if (priceMatch?.[1]) priceConstraint = parseFloat(priceMatch[1]);

    // Build product terms for matching
    const allTerms = mappedProducts.flatMap(p => [
      p.title.toLowerCase(),
      ...(p.category ? p.category.toLowerCase().split(/\s*,\s*/) : [])
    ]);
    const productTerms = [...new Set(allTerms.filter(term => term.length > 2))];

    const productRegex = new RegExp(
      productTerms
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|'),
      'i'
    );

    // Detect intents
    const lowerQuery = query.toLowerCase();

    // Fix the keyword matching logic to ensure we catch variations of the keywords
    // In your API route (/api/customer-assistant)
    const isRedirectionRequest = /(buy|purchase|order|checkout)\s+(?:me\s+)?(?:a\s+)?(?:the\s+)?(?:this\s+)?/i.test(lowerQuery);
    const isViewRequest = /(view|see|show me|navigate to|go to)\s+(?:me\s+)?(?:a\s+)?(?:the\s+)?/i.test(lowerQuery);
    const isAddToCartRequest = /(add to cart|put in cart|add this to cart|add item to cart)/i.test(lowerQuery);
    const productTypeMatch = lowerQuery.match(productRegex);
    const productType = productTypeMatch?.[0];

    // Filter products
    let filteredProducts = mappedProducts;
    if (productType) {
      filteredProducts = filteredProducts.filter(p =>
        p.title.toLowerCase().includes(productType) ||
        (p.category && p.category.toLowerCase().includes(productType))
      );
    }
    if (priceConstraint !== null) {
      filteredProducts = filteredProducts.filter(p => p.price <= priceConstraint!);
    }


    let productName = '';
    if (isRedirectionRequest || isViewRequest || isAddToCartRequest) {
      const productMatch = lowerQuery.match(/(?:buy|view|add to cart)\s+(?:me\s+)?(?:a\s+)?(?:the\s+)?([^\.\?]+)/i);
      if (productMatch) {
        productName = productMatch[1].trim();
      }
    }

    if (isViewRequest && productName && filteredProducts.length) {
      const product = filteredProducts[0];
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

    // For buy requests
    if (isRedirectionRequest && productName && filteredProducts.length) {
      const product = filteredProducts[0];
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

    // For add to cart requests
    if (isAddToCartRequest && productName && filteredProducts.length) {
      const product = filteredProducts[0];
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
    // Prepare AI prompt
    const productList = mappedProducts
      .map(p => `ID: ${p._id}\nTitle: ${p.title}\nPrice: $${p.price}\nStock: ${p.inventory}\nDescription: ${p.description}\nImage: ${p.image_url}`)
      .join("\n\n");

    const conversationContext = history
      ?.slice(-config.maxHistoryLength)
      ?.map(msg => `${msg.role === 'user' ? 'Customer' : 'Assistant'}: ${msg.content}`)
      ?.join('\n') || "No previous conversation";

    const prompt = `
You are a friendly, helpful shopping assistant for ${config.storeName}. Your job is to sound like a real person—warm, engaging, and natural. Use contractions, occasional fillers (like "let's see", "hmm", "oh!"), and polite enthusiasm.

**STRICT RULES:**
1. ONLY recommend products that EXACTLY match the customer's query
2. If no products match perfectly, DO NOT show any products
3. NEVER recommend unrelated products (e.g., if asked for chairs, never show tables)
4. Always use the provided HTML card format for product displays
5. Include product images in every product card

**Previous conversation context:**  
${conversationContext}  

**Customer's latest question:**  
"${query}"  

**Available products:**  
${productList}  

**Response Guidelines:**
- If user greet like say Hi, warmly greet user to and ask user if he need any help
- Be conversational: "Oh, I found..." or "Hmm, let me check..."
- If no matching products: "Hmm, I checked but we don't have XYZ right now..."
- When showing products:
  1. Use EXACTLY this HTML format:
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
`;

    const res = await services.openai.chat.completions.create({
      model: config.aiModel,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 1000
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
