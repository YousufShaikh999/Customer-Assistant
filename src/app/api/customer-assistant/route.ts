import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import mysql from 'mysql2/promise';
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

interface ProductRow extends mysql.RowDataPacket {
  product_id: number;
  title: string;
  price: number;
  description: string;
  thumbnail_id?: string;
  post_name: string;
}

interface Product {
  id: number;
  title: string;
  price: string;
  description: string;
  image_url?: string;
  slug: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: {
    products?: Product[];
    action?: 'view' | 'add_to_cart' | 'buy';
    productId?: number;
    count?: number;
    keyword?: string;
  };
}

interface APIResponse {
  reply: string;
  products?: Product[];
  history?: ChatMessage[];
  error?: string;
  debug?: any;
  redirect?: string;
}



const requestSchema = z.object({
  query: z.string().min(1, "Query cannot be empty").max(300, "Query too long"),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    metadata: z.any().optional()
  })).optional()
});

const initializeServices = () => {
  const requiredEnvVars = ['OPENAI_API_KEY', 'WP_DB_HOST', 'WP_DB_USER', 'WP_DB_PASSWORD', 'WP_DB_NAME'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
  }

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    timeout: 20000
  });

  const pool = mysql.createPool({
    host: process.env.WP_DB_HOST,
    user: process.env.WP_DB_USER,
    password: process.env.WP_DB_PASSWORD || '',
    database: process.env.WP_DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });

  return { openai, pool };
};

let services: { openai: OpenAI; pool: mysql.Pool };

try {
  services = initializeServices();
} catch (initError) {
  console.error("Service initialization failed:", initError);
  throw new Error("Service initialization error");
}

const extractProductCount = (query: string): number => {
  const countMatch = query.match(/(?:show|recommend|give me|i want|display)\s+(\d+)/i);
  return countMatch ? Math.min(parseInt(countMatch[1]), 10) : 3; // Limit to max 10 products
};

const extractKeyword = (query: string): string | null => {
  const keywords = ['chair', 'sofa', 'bed', 'table', 'lamp', 'couch', 'furniture', 'desk', 'wardrobe', 'shelf'];
  const lower = query.toLowerCase();
  return keywords.find(k => lower.includes(k)) || null;
};

const getPreviouslyShownIds = (history: ChatMessage[]): number[] => {
  return history
    .filter(msg => msg.metadata?.products)
    .flatMap(msg => msg.metadata?.products?.map((p: Product) => p.id) ?? []);
};

const shuffleArray = <T>(array: T[]): T[] => {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
};

const selectProducts = (
  allProducts: Product[],
  desiredCount: number,
  keyword: string | null,
  previouslyShownIds: number[]
): Product[] => {
  // First filter by keyword if provided
  let filteredProducts = keyword
    ? allProducts.filter(p =>
        (p.title.toLowerCase().includes(keyword) ||
         p.description.toLowerCase().includes(keyword)) &&
        !previouslyShownIds.includes(p.id))
    : allProducts.filter(p => !previouslyShownIds.includes(p.id));

  // If no keyword matches or not enough products, fall back to all available products
  if (filteredProducts.length < desiredCount) {
    filteredProducts = allProducts.filter(p => !previouslyShownIds.includes(p.id));
  }

  // If still not enough, start repeating but maintain the count
  if (filteredProducts.length < desiredCount) {
    const needed = desiredCount - filteredProducts.length;
    const repeatedProducts = allProducts
      .filter(p => !filteredProducts.some(fp => fp.id === p.id))
      .slice(0, needed);
    filteredProducts = [...filteredProducts, ...repeatedProducts];
  }

  // Shuffle and select the desired count
  return shuffleArray(filteredProducts).slice(0, desiredCount);
};
const detectAction = (query: string, products: Product[], context: ChatMessage[]): { action: 'view' | 'add_to_cart' | 'buy' | null, product: Product | null } => {
  const lowerQuery = query.toLowerCase();
  const viewWords = ['view', 'show', 'details', 'see', 'look at', 'display', 'more about'];
  const cartWords = ['add to cart', 'put in cart', 'in cart', 'cart', 'add it', 'include in cart'];
  const buyWords = ['buy', 'buy now', 'purchase', 'checkout', 'order', 'get it now'];

  // First try to find product mentioned in current query
  let matchedProduct = products.find(product =>
    lowerQuery.includes(product.title.toLowerCase()) ||
    lowerQuery.includes(product.slug.toLowerCase())
  );

  // If no product mentioned, look for previously discussed product
  if (!matchedProduct) {
    const lastDiscussedProduct = context
      .slice()
      .reverse()
      .find(msg => msg.metadata?.products || msg.metadata?.productId);

    if (lastDiscussedProduct?.metadata?.products) {
      matchedProduct = lastDiscussedProduct.metadata.products[0];
    } else if (lastDiscussedProduct?.metadata?.productId) {
      matchedProduct = products.find(p => p.id === lastDiscussedProduct.metadata?.productId);
    }
  }

  if (!matchedProduct) return { action: null, product: null };

  if (viewWords.some(word => lowerQuery.includes(word))) {
    return { action: 'view', product: matchedProduct };
  }

  if (cartWords.some(word => lowerQuery.includes(word))) {
    return { action: 'add_to_cart', product: matchedProduct };
  }

  if (buyWords.some(word => lowerQuery.includes(word))) {
    return { action: 'buy', product: matchedProduct };
  }

  return { action: null, product: matchedProduct };
};

const generateProductCards = (products: Product[]): string => {
  if (!products.length) return '';

  const cards = products.map(product => `
      <div style="display:flex; flex-wrap:wrap; justify-content:center; gap:10px;">
        <a href='http://plugin.ijkstaging.com/product/${product.slug}' target='_blank' style='background:#2563EB; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none;'>View Product</a>
    <div class="product-card" style='
      border-radius: 12px;
      margin-bottom: 16px;
      display: flex;
      text-align: center;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      height: 100%;
    '>
      <div class="product-image-container" style='
        width: 100%;
        height: 200px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 12px;
        overflow: hidden;
        border-radius: 8px;
        background: #f5f5f5;
      '>
        ${product.image_url ? `
          <img 
            src="${product.image_url}" 
            alt="${product.title}"
            loading="lazy"
            style='
              max-width: 100%;
              max-height: 100%;
              object-fit: contain;
              transition: opacity 0.3s ease;
              opacity: 0;
            '
            onload="this.style.opacity='1'"
          />
          <noscript>
            <img 
              src="${product.image_url}" 
              alt="${product.title}"
              style='
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
              '
            />
          </noscript>
        ` : `
          <div style='
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #eaeaea;
            color: #999;
            font-size: 14px;
          '>
            No image available
          </div>
        `}
      </div>
      
      <div style='flex: 1; display: flex; flex-direction: column; width: 100%;'>
        <h3 style='
          font-size: 1.1rem;
          font-weight: 600;
          color: #333;
          margin: 0 0 8px 0;
          line-height: 1.3;
        '>
          ${product.title}
        </h3>
        
        <p style='
          font-size: 0.9rem;
          color: #666;
          margin: 0 0 12px 0;
          line-height: 1.4;
          flex-grow: 1;
        '>
          ${product.description.substring(0, 100)}${product.description.length > 100 ? '...' : ''}
        </p>
        
        <p style='
          font-size: 1.1rem;
          color: #2d3748;
          font-weight: 700;
          margin: 0 0 16px 0;
        '>
          $${product.price}
        </p>
        
        <div style="
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 8px;
          margin-top: auto;
        ">
          <button 
            onclick="window.top.location.href='http://plugin.ijkstaging.com/product/${product.slug}'"
            target="_blank" 
            rel="noopener noreferrer"
            style='
              background: #2563EB;
              color: white;
              padding: 10px 16px;
              border-radius: 6px;
              text-decoration: none;
              font-size: 0.9rem;
              transition: background 0.2s ease;
              flex: 1;
              min-width: 120px;
              text-align: center;
            '
            onmouseover="this.style.background='#1d4ed8'"
            onmouseout="this.style.background='#2563EB'"
          >
            View Details
          </button>
          
          <button 
            onclick="window.top.location.href='http://plugin.ijkstaging.com/shop/?add-to-cart=${product.id}'" 
            target="_blank" 
            rel="noopener noreferrer"
            style='
              background: #1e40af;
              color: white;
              padding: 10px 16px;
              border-radius: 6px;
              text-decoration: none;
              font-size: 0.9rem;
              transition: background 0.2s ease;
              flex: 1;
              min-width: 120px;
              text-align: center;
            '
            onmouseover="this.style.background='#1e3a8a'"
            onmouseout="this.style.background='#1e40af'"
          >
            Add to Cart
          </button>
          
          <button 
            onclick="window.top.location.href='http://plugin.ijkstaging.com/checkout/?add-to-cart=${product.id}'" 
            target="_blank" 
            rel="noopener noreferrer"
            style='
              background: #065f46;
              color: white;
              padding: 10px 16px;
              border-radius: 6px;
              text-decoration: none;
              font-size: 0.9rem;
              transition: background 0.2s ease;
              flex: 1;
              min-width: 120px;
              text-align: center;
            '
            onmouseover="this.style.background='#064e3b'"
            onmouseout="this.style.background='#065f46'"
          >
            Buy Now
          </button>
        </div>
      </div>
    </div>
  `).join('');

  return `
    <style>
      .product-card:hover {
        transform: translateY(-4px);
        box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
      }
    </style>
    <div style="
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 24px;
      margin: 24px 0;
    ">
      ${cards}
    </div>
  `;
};

const generateSystemPrompt = (context: ChatMessage[], products: Product[]): string => {
  const lastMessages = context.slice(-3).map(m => `${m.role}: ${m.content}`).join('\n');

  return `You are a helpful shopping assistant for a store. Current conversation context:
${lastMessages}

Available products (${products.length} shown):
${products.map(p => `- ${p.title} ($${p.price})`).join('\n')}

Guidelines:
1. Be conversational and friendly
2. Don't recommend products until user asks
3. Only recommend products from the available list
4. If user asks about a specific product, provide details
5. If user wants to view/add/buy a product, confirm the action
6. Keep responses concise but helpful
7. Remember previous messages in the conversation`;
};

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let connection: mysql.PoolConnection | null = null;

  try {
    connection = await services.pool.getConnection();
    const body = await req.json().catch(() => {
      throw new Error("Invalid JSON body");
    });

    const validationResult = requestSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json({
        reply: "Invalid request format",
        error: validationResult.error.flatten()
      }, { status: 400 });
    }

    const { query, history = [] } = validationResult.data;

    // Initialize conversation if empty
    const updatedHistory: ChatMessage[] = history.length === 0
      ? [{
        role: 'assistant',
        content: "Hello! I'm your furniture shopping assistant. How can I help you today?",
        metadata: {}
      }]
      : history as ChatMessage[];

    try {
      connection = await services.pool.getConnection();

      // Get all products from database
      const [allProductsRaw] = await connection.query<ProductRow[]>(`
        SELECT 
          p.ID as product_id,
          p.post_title as title,
          p.post_name as post_name,
          pm_price.meta_value as price,
          p.post_content as description,
          pm_thumbnail.meta_value as thumbnail_id
        FROM wp_posts p
        LEFT JOIN wp_postmeta pm_price ON p.ID = pm_price.post_id AND pm_price.meta_key = '_price'
        LEFT JOIN wp_postmeta pm_thumbnail ON p.ID = pm_thumbnail.post_id AND pm_thumbnail.meta_key = '_thumbnail_id'
        WHERE p.post_type = 'product' 
        AND p.post_status = 'publish'
        AND pm_price.meta_value IS NOT NULL
        ORDER BY RAND() -- Randomize the order each time
        LIMIT 100
      `);

      if (!allProductsRaw.length) {
        return NextResponse.json({
          reply: "Currently we don't have any products available. Please check back later.",
          history: updatedHistory
        });
      }
      // Get product images
      const productImages = new Map<number, string>();
      const thumbnailIds = allProductsRaw
        .filter(p => p.thumbnail_id)
        .map(p => p.thumbnail_id);

      if (thumbnailIds.length > 0) {
        const [images] = await connection.query(`
          SELECT 
            posts.ID as image_id,
            posts.guid as image_url
          FROM wp_posts posts
          WHERE posts.ID IN (${thumbnailIds.join(',')})
          AND posts.post_type = 'attachment'
        `);

        if (Array.isArray(images)) {
          images.forEach((img: any) => {
            productImages.set(img.image_id, img.image_url);
          });
        }
      }

      // Prepare product data
      const allProductsWithImages: Product[] = allProductsRaw.map(p => ({
        id: p.product_id,
        title: p.title,
        price: p.price.toString(),
        description: p.description,
        image_url: p.thumbnail_id ? productImages.get(parseInt(p.thumbnail_id)) : undefined,
        slug: p.post_name
      }));

      // Determine what products to show based on conversation
      const desiredCount = extractProductCount(query);
      const keyword = extractKeyword(query);

      // Check if we have a previous product selection in the conversation
      const previousSelection = updatedHistory
        .slice()
        .reverse()
        .find(msg => msg.metadata?.products);

      const previouslyShownIds = getPreviouslyShownIds(updatedHistory);
      // Filter products based on keyword and exclude previously shown
      let filteredProducts = keyword
        ? allProductsWithImages.filter(p =>
          (p.title.toLowerCase().includes(keyword) ||
            p.description.toLowerCase().includes(keyword)) &&
          !previouslyShownIds.includes(p.id)
        ) : allProductsWithImages.filter(p => !previouslyShownIds.includes(p.id));

      // If we filtered out all products, reset the filter but keep the count
      if (filteredProducts.length === 0) {
        filteredProducts = allProductsWithImages.slice(0, desiredCount);
      } else {
        filteredProducts = filteredProducts.slice(0, desiredCount);
      }

      // Check for actions (view/add/buy)
      const { action, product } = detectAction(query, allProductsWithImages, updatedHistory);

      if (action && product) {
        let redirectUrl = '';
        let actionMessage = '';

        switch (action) {
          case 'view':
            redirectUrl = `window.top.location.href='http://plugin.ijkstaging.com/product/${product.slug}/`;
            actionMessage = `Taking you to the ${product.title} page...`;
            break;
          case 'add_to_cart':
            redirectUrl = `window.top.location.href='http://plugin.ijkstaging.com/shop/?add-to-cart=${product.id}'`;
            actionMessage = `Added ${product.title} to your cart!`;
            break;
          case 'buy':
            redirectUrl = `window.top.location.href='http://plugin.ijkstaging.com/checkout/?add-to-cart=${product.id}'`;
            actionMessage = `Taking you to checkout with ${product.title}...`;
            break;
        }

        return NextResponse.json({
          reply: actionMessage,
          redirect: redirectUrl,
          history: [
            ...updatedHistory,
            {
              role: 'user',
              content: query,
              metadata: { productId: product.id }
            },
            {
              role: 'assistant',
              content: actionMessage,
              metadata: {
                action,
                productId: product.id
              }
            }
          ]
        });
      }

      // Generate product cards HTML
      const productCardsHTML = generateProductCards(filteredProducts);

      // Generate system prompt for OpenAI
      const systemPrompt = generateSystemPrompt(updatedHistory, filteredProducts);

      // Prepare messages for OpenAI
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...updatedHistory
          .filter(msg => msg.role !== 'system')
          .map(msg => ({ role: msg.role, content: msg.content } as const)),
        { role: 'user', content: query }
      ];

      // Get response from OpenAI
      const completion = await services.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages,
        temperature: 0.7,
        max_tokens: 500
      });

      const aiReply = completion.choices[0]?.message?.content || "I couldn't generate a response.";
      const fullReply = `${aiReply}${productCardsHTML}`;

      return NextResponse.json({
        reply: fullReply,
        products: filteredProducts,
        history: [
          ...updatedHistory,
          {
            role: 'user',
            content: query,
            metadata: { keyword }
          },
          {
            role: 'assistant',
            content: fullReply,
            metadata: {
              products: filteredProducts,
              count: desiredCount,
              keyword
            }
          }
        ]
      });

    } catch (dbError) {
      console.error("Database error:", dbError);
      return NextResponse.json({
        reply: "Sorry, we're having trouble accessing our product information.",
        error: "Database operation failed",
        debug: process.env.NODE_ENV === 'development' ? dbError : undefined
      }, { status: 500 });
    } finally {
      if (connection) connection.release();
    }

  } catch (error) {
    console.error("API processing error:", error);
    return NextResponse.json({
      reply: "Sorry, I'm having trouble processing your request.",
      error: error instanceof Error ? error.message : "Unknown error",
      debug: process.env.NODE_ENV === 'development' ? error : undefined,
      processingTime: `${Date.now() - startTime}ms`
    }, { status: 500 });
  }
}