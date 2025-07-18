import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

interface ProductWithTagsArray {
  title: string;
  inventory: number;
}

export async function generateDescription(title: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "user",
        content: `Write a compelling 5 to 7 words sentence product description for: ${title} and dont use " and ! in start and end of the sentence`,
      },
    ],
  });

  return res.choices[0].message.content || "";
}

export async function getInventoryInsights(
  products: ProductWithTagsArray[]
): Promise<string> {
  const formattedList = products
    .map((p) => `• ${p.title} — ${p.inventory} in stock`)
    .join("\n");

  const prompt = `
You are an e-commerce assistant. Given the following inventory list, give a summary of what's happening. 
Highlight low stock items (less than 5), and recommend restocking if needed.

Inventory:
${formattedList}
  `;

  const res = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  return res.choices[0].message.content || "";
}

export async function getAdminInsights({
  products,
  orders,
  users,
}: {
  products: any[];
  orders: any[];
  users: any[];
}) {
  const prompt = `
You are an e-commerce admin assistant AI. Analyze the following data and give insights:

1. Products:
  - Top 3 low-stock products
  - Top 3 overstocked items
  - General pricing observations

2. Orders:
  - Which products sell most?
  - Average order value
  - Recent trends (if any)

3. Users:
  - Total number of users
  - Active vs inactive users (based on orders)
  - Any user behavior patterns

Products:\n${JSON.stringify(products, null, 2)}

Orders:\n${JSON.stringify(orders, null, 2)}

Users:\n${JSON.stringify(users, null, 2)}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4,
  });

  return res.choices[0].message.content?.trim();
}

export async function generateTags(description: string): Promise<string[]> {
  const res = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "user",
        content: `Suggest 3 relevant product tags for this description, comma-separated only:\n"${description}"`,
      },
    ],
  });

  const text = res.choices[0].message.content?.trim() || "";

  return text.split(",").map(tag => tag.trim()).filter(Boolean);
}

