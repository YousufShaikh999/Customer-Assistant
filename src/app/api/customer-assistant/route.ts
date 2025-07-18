import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import mysql from 'mysql2/promise';
import { z } from "zod";
import dotenv from 'dotenv';

dotenv.config();

// Enhanced Type Definitions
interface ProductRow extends mysql.RowDataPacket {
  product_id: number;
  title: string;
  price: number;
  description: string;
  thumbnail_id?: string;
  post_name: string; // Added for product slug
}

interface Product {
  id: number;
  title: string;
  price: string;
  description: string;
  image_url?: string;
  slug: string; // Added for product slug
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface APIResponse {
  reply: string;
  products?: Product[];
  history?: ChatMessage[];
  error?: string;
  debug?: any;
  redirect?: string; // Added for redirect URLs
}

const requestSchema = z.object({
  query: z.string().min(1, "Query cannot be empty").max(500, "Query too long"),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string()
  })).optional()
});

// Initialize services with better error handling
const initializeServices = () => {
  // Verify required environment variables
  const requiredEnvVars = ['OPENAI_API_KEY', 'WP_DB_HOST', 'WP_DB_USER', 'WP_DB_PASSWORD', 'WP_DB_NAME'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
  }

  // Initialize OpenAI
  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    timeout: 20000 // 20 second timeout
  });

  // Initialize Database Pool
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

// Helper function to detect action words
const detectAction = (query: string, products: Product[]): {action: 'view' | 'add_to_cart' | 'buy' | null, product: Product | null} => {
  const lowerQuery = query.toLowerCase();
  const viewWords = ['view', 'show', 'details', 'see', 'look at', 'display'];
  const cartWords = ['add to cart', 'put in cart', 'in cart', 'cart', 'add it'];
  const buyWords = ['buy', 'buy now', 'purchase', 'checkout', 'order'];
  
  // Find the most relevant product in the query
  const matchedProduct = products.find(product => 
    lowerQuery.includes(product.title.toLowerCase()) ||
    lowerQuery.includes(product.slug.toLowerCase())
  );

  if (!matchedProduct) {
    return { action: null, product: null };
  }

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

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let connection: mysql.PoolConnection | null = null;

  try {
    // Parse and validate request
    const body = await req.json().catch(() => {
      throw new Error("Invalid JSON body");
    });

    const validationResult = requestSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          reply: "Invalid request format",
          error: validationResult.error.flatten()
        },
        { status: 400 }
      );
    }

    const { query, history = [] } = validationResult.data;

    // Add a starting message to the history if it's the first interaction
    const updatedHistory = history.length === 0
      ? [{ role: 'assistant', content: "Hello! I'm your shopping assistant. How can I assist you today?" }]
      : history;

    // Database operations
    try {
      connection = await services.pool.getConnection();
      console.log("Database connection established");

      const [products] = await connection.query<ProductRow[]>(`
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
        LIMIT 10
      `);

      if (!products.length) {
        return NextResponse.json({
          reply: "Currently we don't have any products available. Please check back later.",
          history: updatedHistory
        });
      }

      // Get product images for products that have thumbnail IDs
      const productImages = new Map<number, string>();
      const thumbnailIds = products
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

      // Transform products to include image URLs and slugs
      const productsWithImages: Product[] = products.map(p => ({
        id: p.product_id,
        title: p.title,
        price: p.price.toString(),
        description: p.description,
        image_url: p.thumbnail_id ? productImages.get(parseInt(p.thumbnail_id)) : undefined,
        slug: p.post_name
      }));

      // Check for direct actions before processing with AI
      const { action, product } = detectAction(query, productsWithImages);
      
      if (action && product) {
        let redirectUrl = '';
        
        switch (action) {
          case 'view':
            redirectUrl = `http://plugin.ijkstaging.com/product/${product.slug}/`;
            break;
          case 'add_to_cart':
            redirectUrl = `http://plugin.ijkstaging.com/shop/?add-to-cart=${product.id}`;
            break;
          case 'buy':
            redirectUrl = `http://plugin.ijkstaging.com/checkout/?add-to-cart=${product.id}`;
            break;
        }

        return NextResponse.json({
          reply: `Redirecting you to ${product.title}...`,
          redirect: redirectUrl,
          history: [...updatedHistory, { role: 'user', content: query }, { role: 'assistant', content: `Redirecting to ${product.title}` }]
        });
      }

      // Prepare AI context (keep it concise to reduce processing time)
      const productContext = productsWithImages
        .map(p => `ID: ${p.id}\nTitle: ${p.title}\nSlug: ${p.slug}\nPrice: $${p.price}\nDescription: ${p.description.substring(0, 200)}${p.image_url ? `\nImage: ${p.image_url}` : ''}`)
        .join("\n\n---\n");

      const conversationContext = updatedHistory
        .slice(-5)
        .map(msg => `${msg.role}: ${msg.content}`)
        .join('\n');

      const prompt = `You are a friendly, helpful shopping assistant of Shopping Store. Your job is to sound like a real person—warm, engaging, and natural. Use contractions, occasional fillers (like "let's see", "hmm", "oh!"), and polite enthusiasm. Carry the conversation forward, referencing what the customer said before.Check customers query and strictly match the product if product and query are not matching strictly then dont show products. Match products and query like chair to chair, sofa to sofa if product is not perfectly matching query then dont show. Dont show table or other if query have chair also for other types of situations. If you need to clarify, ask a friendly follow-up question. Use conversational transitions ("By the way", "Oh, and...").

Previous conversation:
${conversationContext || 'No previous conversation'}

Available products:
${productContext}

Customer question: "${query}"

Guidelines:
- Be friendly but professional
- Dont recommend products until user asks for recommendations
- If user asks to recommend products, provide at least 3 relevant ones
- If user asks to show some products, provide at least 3
- If user asks for recommendations, provide at least 3 products
- If user asks to provide specific amount of products, provide that many
- If user asks for a specific product, provide that product plus 2-3 similar ones
- Include product IDs when available
- Keep individual product descriptions brief to fit more products
- After providing recommendations, always ask if they need help with anything else


**IMPORTANT: When recommending products, always use this HTML format exactly:**

<ul style="list-style-type: none; padding: 0;">
  <li style='background:#f9f9f9; padding:16px; border:1px solid #ddd; border-radius:8px; margin-bottom:12px; display:flex; flex-direction:column; align-items:center; text-align:center; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);'>
    <img src='http://plugin.ijkstaging.com/wp-content/uploads/2025/07/wp_dummy_content_generator_PRODUCT_ID.jpg' 
         style='max-width:100%; height:auto; max-height:200px; margin-bottom:12px; border-radius:8px;' alt='PRODUCT_TITLE' />
    <strong style='font-size:1.2rem; font-weight:bold; color:#333;'>PRODUCT_TITLE</strong>
    <p style='font-size:1rem; color:#555; margin:8px 0;'>Brief reason why this fits their needs</p>
    <p style='font-size:1.1rem; color:#333; font-weight:bold; margin-bottom:12px;'>Price: $PRODUCT_PRICE</p>
    <div style="display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; width: 100%;">
      <a href='http://plugin.ijkstaging.com/product/PRODUCT_SLUG' target='_blank'
         style='background:#2563EB; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-size:1rem;'>View Product</a>
      <a href='http://plugin.ijkstaging.com/shop/?add-to-cart=PRODUCT_ID' target='_blank'
         style='background:#2563EB; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-size:1rem;'>Add to Cart</a>
      <a href='http://plugin.ijkstaging.com/checkout/?add-to-cart=PRODUCT_ID' target='_blank'
         style='background:#059669; color:#fff; padding:10px 20px; border-radius:6px; text-decoration:none; font-size:1rem;'>Buy Now</a>
    </div>
  </li>
</ul>

IMPORTANT: Always show multiple products. Replace PRODUCT_ID, PRODUCT_TITLE, PRODUCT_PRICE, and PRODUCT_SLUG with actual values from the available products.`;

      // Get AI response (optimize time by reducing tokens and request size)
      const completion = await services.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 800 // Reduce the token limit to improve response time
      });

      const reply = completion.choices[0]?.message?.content ||
        "I couldn't generate a response. Please try again.";

      return NextResponse.json({
        reply,
        products: productsWithImages,
        history: [...updatedHistory, { role: 'user', content: query }, { role: 'assistant', content: reply }]
      });

    } catch (dbError) {
      console.error("Database error:", dbError);
      return NextResponse.json(
        {
          reply: "Sorry, we're having trouble accessing our product information.",
          error: "Database operation failed",
          debug: process.env.NODE_ENV === 'development' ? dbError : undefined
        },
        { status: 500 }
      );
    } finally {
      if (connection) connection.release();
    }

  } catch (error) {
    console.error("API processing error:", error);
    return NextResponse.json(
      {
        reply: "Sorry, I'm having trouble processing your request.",
        error: error instanceof Error ? error.message : "Unknown error",
        debug: process.env.NODE_ENV === 'development' ? error : undefined,
        processingTime: `${Date.now() - startTime}ms`
      },
      { status: 500 }
    );
  }
}