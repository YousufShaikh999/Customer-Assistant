"use client";

import React, { useState, useEffect, useRef } from "react";
import { Sparkles, Send, RotateCw, X, MessageCircle } from "lucide-react";
import DOMPurify from "dompurify";
import { useRouter } from "next/navigation";

interface Message {
  id: string;
  content: string;
  isUser: boolean;
  timestamp: Date;
}

interface Product {
  id: string;
  title: string;
  price: number;
  image_url?: string;
}

const CustomerAssistant = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    type: "buy" | "addToCart";
    productId: string;
    productTitle: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const toggleChat = () => {
    setIsOpen(!isOpen);
    if (!isOpen) {
      sessionStorage.setItem("chatOpen", "true");
    } else {
      sessionStorage.removeItem("chatOpen");
    }
  };

  const addMessage = (message: Message) => {
    setMessages((prev) => [...prev, message]);
  };

  useEffect(() => {
    // Handle click events for all interactive elements in messages
    const handleMessageClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Handle buy now buttons
      const buyButton = target.closest(".assistant-buy-now-btn");
      if (buyButton) {
        e.preventDefault();
        const productId = buyButton.getAttribute("data-product-id");
        const productTitle = buyButton.getAttribute("data-product-title");
        if (productId && productTitle) {
          setPendingAction({
            type: "buy",
            productId,
            productTitle,
          });
          addMessage({
            id: Date.now().toString(),
            content: `Are you sure you want to buy ${productTitle}? (Type "yes" to confirm)`,
            isUser: false,
            timestamp: new Date(),
          });
        }
        return;
      }

      // Handle add to cart buttons
      const addToCartButton = target.closest(".assistant-add-to-cart-btn");
      if (addToCartButton) {
        e.preventDefault();
        const productId = addToCartButton.getAttribute("data-product-id");
        const productTitle = addToCartButton.getAttribute("data-product-title");
        if (productId && productTitle) {
          setPendingAction({
            type: "addToCart",
            productId,
            productTitle,
          });
          addMessage({
            id: Date.now().toString(),
            content: `Are you sure you want to add ${productTitle} to your cart? (Type "yes" to confirm)`,
            isUser: false,
            timestamp: new Date(),
          });
        }
        return;
      }

      // Handle product links (let them work normally)
      const productLink = target.closest(".assistant-product-link");
      if (productLink) {
        // Links will work normally
        return;
      }
    };

    document.addEventListener("click", handleMessageClick);
    return () => {
      document.removeEventListener("click", handleMessageClick);
    };
  }, []);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      const hasWelcomeMessage = messages.some(
        (msg) =>
          msg.content.includes("Hello! How can I assist you today?") && !msg.isUser
      );

      if (!hasWelcomeMessage) {
        addMessage({
          id: Date.now().toString(),
          content: "Hello! How can I assist you today?",
          isUser: false,
          timestamp: new Date(),
        });
      }
    }
  }, [isOpen, messages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleRedirect = (url: string) => {
    // Send message to parent WordPress to handle the redirection
    window.parent.postMessage({ type: "redirect", url: url }, "*");
  };

  const handleAddToCart = (productId: string) => {
    // Store messages before redirecting
    sessionStorage.setItem("chatMessages", JSON.stringify(messages));
    sessionStorage.setItem("chatOpen", "true");

    // Redirect to add-to-cart URL
    handleRedirect(`https://plugin.ijkstaging.com/shop/?add-to-cart=${productId}`);
  };

  const handleBuyNow = (productId: string) => {
    // Store messages before redirecting
    sessionStorage.setItem("chatMessages", JSON.stringify(messages));
    sessionStorage.setItem("chatOpen", "true");

    // Redirect to checkout
    handleRedirect(`/checkout/?add-to-cart=${productId}`);
  };

  const handleSubmit = async () => {
    if (!input.trim()) {
      setError("Please enter a message");
      return;
    }

    // Handle confirmation for pending actions
    if (pendingAction && input.toLowerCase().trim() === "yes") {
      if (pendingAction.type === "buy") {
        handleBuyNow(pendingAction.productId);
      } else if (pendingAction.type === "addToCart") {
        handleAddToCart(pendingAction.productId);
      }
      setPendingAction(null);
      setInput("");
      return;
    }

    const userMessage = {
      id: Date.now().toString(),
      content: input,
      isUser: true,
      timestamp: new Date(),
    };

    addMessage(userMessage);
    setInput("");
    setLoading(true);
    setError("");
    setPendingAction(null);

    try {
      const res = await fetch("/api/customer-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input,
          history: messages.filter((m) => !m.isUser).map((m) => ({
            role: "assistant",
            content: m.content,
          })),
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(
          errorData.error ||
            errorData.message ||
            `Request failed with status ${res.status}`
        );
      }

      const data = await res.json();

      // Handle different response types
      if (data.redirect) {
        const aiMessage = {
          id: Date.now().toString(),
          content: data.reply,
          isUser: false,
          timestamp: new Date(),
        };
        addMessage(aiMessage);

        sessionStorage.setItem("chatMessages", JSON.stringify([...(messages || []), userMessage, aiMessage]));
        sessionStorage.setItem("chatOpen", "true");

        // Handle redirection
        if (data.redirect.startsWith("/")) {
          router.push(data.redirect);
        } else {
          handleRedirect(data.redirect);
        }
        return;
      }

      // Handle product display
      const aiMessage = {
        id: Date.now().toString(),
        content: data.reply,
        isUser: false,
        timestamp: new Date(),
      };
      addMessage(aiMessage);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to get response";
      setError(errorMessage);

      // Add error message to chat
      addMessage({
        id: Date.now().toString(),
        content: `<span style="color:red;">Sorry, I encountered an error: ${errorMessage}</span>`,
        isUser: false,
        timestamp: new Date(),
      });

      console.error("API Error:", err);
    } finally {
      setLoading(false);
    }
  };

  const renderMessageContent = (content: string) => {
    const sanitized = DOMPurify.sanitize(content, {
      ADD_TAGS: ["img", "button", "a"],
      ADD_ATTR: ["style", "src", "alt", "href", "class", "data-product-id", "data-product-title", "target"],
    });

    return <div dangerouslySetInnerHTML={{ __html: sanitized }} />;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (!isOpen) {
    return (
      <div className="fixed bottom-8 right-8 z-50">
        <button
          onClick={toggleChat}
          className="bg-blue-600 text-white p-4 rounded-full shadow-lg hover:bg-blue-700 transition transform hover:scale-110"
          aria-label="Open chat"
        >
          <MessageCircle size={28} />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-full max-w-[calc(100%-2rem)] sm:max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl">
      <div className="w-full h-[calc(100vh-8rem)] sm:h-[600px] bg-gradient-to-t from-white via-blue-50 to-blue-100 shadow-xl rounded-2xl overflow-hidden border border-gray-300 flex flex-col">
        {/* Chat header */}
        <div className="bg-blue-600 text-white p-4 flex items-center justify-between rounded-t-xl">
          <div className="flex items-center gap-2 sm:gap-3">
            <Sparkles className="text-yellow-300 w-6 h-6 sm:w-7 sm:h-7" />
            <h2 className="text-lg sm:text-xl font-semibold">Shopping Assistant</h2>
          </div>
          <button
            onClick={toggleChat}
            className="text-white hover:text-gray-200 transition"
            aria-label="Close chat"
          >
            <X className="w-6 h-6 sm:w-7 sm:h-7" />
          </button>
        </div>

        {/* Messages area */}
        <div
          id="assistant-chat-area"
          className="flex-1 overflow-y-auto p-4 space-y-4"
        >
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.isUser ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-xl p-3 sm:p-4 text-sm sm:text-base ${message.isUser
                  ? "bg-blue-600 text-white rounded-br-none shadow-lg"
                  : "bg-gray-100 text-gray-800 rounded-bl-none shadow-md"
                  }`}
              >
                {renderMessageContent(message.content)}
                <p className="text-xs opacity-70 mt-1 sm:mt-2">
                  {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-100 text-gray-800 rounded-xl rounded-bl-none p-2 sm:p-3 max-w-[85%]">
                <div className="flex items-center gap-2 sm:gap-3">
                  <RotateCw className="animate-spin w-5 h-5 sm:w-[22px] sm:h-[22px]" />
                  <span className="text-sm sm:text-base">Thinking...</span>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="border-t border-gray-300 p-4 bg-white shadow-inner rounded-b-xl">
          {error && (
            <div className="mb-2 sm:mb-3 p-3 bg-red-100 text-red-700 rounded-lg text-sm sm:text-base shadow-md">
              {error}
            </div>
          )}
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                pendingAction
                  ? "Type 'yes' to confirm or anything else to cancel"
                  : "Type your message..."
              }
              className="flex-1 px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm sm:text-base"
              disabled={loading}
            />
            <button
              onClick={handleSubmit}
              disabled={loading || !input.trim()}
              className="bg-blue-600 text-white p-3 rounded-xl hover:bg-blue-700 transition disabled:opacity-50"
            >
              <Send className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CustomerAssistant;
