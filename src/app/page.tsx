"use client";

import React, { useState, useEffect, useRef } from "react";
import { Sparkles, Send, RotateCw, X, MessageCircle, ChevronDown, ChevronUp } from "lucide-react";
import DOMPurify from "dompurify";
import { useRouter } from "next/navigation";
import { useDebounce } from "use-debounce";

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
  const [isMinimized, setIsMinimized] = useState(false);
  const [typingIndicator, setTypingIndicator] = useState(false);
  const [initialMessageShown, setInitialMessageShown] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    type: "buy" | "addToCart";
    productId: string;
    productTitle: string;
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [debouncedMessages] = useDebounce(messages, 1000);

  // Initialize chat from storage
  useEffect(() => {
    const savedSessionId = localStorage.getItem("chatSessionId");
    const savedMessages = sessionStorage.getItem("chatMessages");
    const chatWasOpen = sessionStorage.getItem("chatOpen");

    if (savedSessionId) {
      setSessionId(savedSessionId);
    }

    if (savedMessages) {
      try {
        const parsedMessages = JSON.parse(savedMessages);
        if (Array.isArray(parsedMessages)) {
          const recentMessages = parsedMessages.filter((msg: any) =>
            Date.now() - new Date(msg.timestamp).getTime() < 5 * 60 * 1000
          );
          setMessages(recentMessages.map((msg: any) => ({
            ...msg,
            timestamp: new Date(msg.timestamp)
          })));
          setInitialMessageShown(true); // Mark as shown if we loaded messages
        }
      } catch (e) {
        console.error("Failed to parse saved messages", e);
      }
    }

    if (chatWasOpen === "true") {
      setIsOpen(true);
    }

    // Set up periodic refresh
    const refreshInterval = setInterval(() => {
      refreshSession();
    }, 5 * 60 * 1000); // 5 minutes

    return () => clearInterval(refreshInterval);
  }, []);

  useEffect(() => {
    if (isOpen && messages.length === 0 && !initialMessageShown) {
      const welcomeMessage = {
        id: Date.now().toString(),
        content: "Hello! 👋 I'm your shopping assistant. How can I help you today?",
        isUser: false,
        timestamp: new Date(),
      };
      addMessage(welcomeMessage);
      setInitialMessageShown(true);
    }
  }, [isOpen, messages.length, initialMessageShown]);

  // Save messages to sessionStorage when they change
  useEffect(() => {
    if (debouncedMessages.length > 0) {
      sessionStorage.setItem("chatMessages", JSON.stringify(debouncedMessages));
    }
  }, [debouncedMessages]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const refreshSession = async () => {
    try {
      if (sessionId) {
        const response = await fetch('/api/customer-assistant/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.newSessionId && data.newSessionId !== sessionId) {
            setSessionId(data.newSessionId);
            localStorage.setItem("chatSessionId", data.newSessionId);
          }
          setLastRefresh(Date.now());
        }
      }

      // Clean up old messages
      setMessages(prev => {
        const recentMessages = prev.filter(
          msg => Date.now() - msg.timestamp.getTime() < 5 * 60 * 1000
        );
        sessionStorage.setItem("chatMessages", JSON.stringify(recentMessages));
        return recentMessages;
      });
    } catch (err) {
      console.error("Session refresh error:", err);
    }
  };

  const toggleChat = () => {
    const newState = !isOpen;
    setIsOpen(newState);

    if (newState) {
      sessionStorage.setItem("chatOpen", "true");
      setTimeout(() => inputRef.current?.focus(), 300);
    } else {
      sessionStorage.removeItem("chatOpen");
    }
  };

  const toggleMinimize = () => {
    setIsMinimized(!isMinimized);
  };

  const addMessage = (message: Message) => {
    setMessages(prev => {
      const newMessages = [...prev, message];
      sessionStorage.setItem("chatMessages", JSON.stringify(newMessages));
      return newMessages;
    });

    if (!message.isUser) {
      setTypingIndicator(true);
      setTimeout(() => setTypingIndicator(false), 1000);
    }
  };

  useEffect(() => {
    const handleMessageClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

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
            content: `Are you sure you want to buy <strong>${productTitle}</strong>? (Type "yes" to confirm or anything else to cancel)`,
            isUser: false,
            timestamp: new Date(),
          });
        }
        return;
      }

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
            content: `Are you sure you want to add <strong>${productTitle}</strong> to your cart? (Type "yes" to confirm or anything else to cancel)`,
            isUser: false,
            timestamp: new Date(),
          });
        }
        return;
      }

      const productLink = target.closest(".assistant-product-link");
      if (productLink) {
        return;
      }
    };

    document.addEventListener("click", handleMessageClick);
    return () => {
      document.removeEventListener("click", handleMessageClick);
    };
  }, []);

  const handleRedirect = (url: string) => {
    console.log("Redirecting to:", url);
    window.open(url, "_blank");
  };

  const handleAddToCart = (productId: string) => {
    sessionStorage.setItem("chatMessages", JSON.stringify(messages));
    sessionStorage.setItem("chatOpen", "true");
    handleRedirect(`https://plugin.ijkstaging.com/shop/?add-to-cart=${productId}`);
  };

  const handleBuyNow = (productId: string) => {
    sessionStorage.setItem("chatMessages", JSON.stringify(messages));
    sessionStorage.setItem("chatOpen", "true");
    handleRedirect(`https://plugin.ijkstaging.com/checkout/?add-to-cart=${productId}`);
  };

  const handleSubmit = async () => {
    if (!input.trim()) {
      setError("Please enter a message");
      return;
    }

    if (pendingAction && input.toLowerCase().trim() === "yes") {
      const actionMessage = {
        id: Date.now().toString(),
        content: `Processing your request for <strong>${pendingAction.productTitle}</strong>...`,
        isUser: false,
        timestamp: new Date(),
      };
      addMessage(actionMessage);

      if (pendingAction.type === "buy") {
        setTimeout(() => handleBuyNow(pendingAction.productId), 1000);
      } else if (pendingAction.type === "addToCart") {
        setTimeout(() => handleAddToCart(pendingAction.productId), 1000);
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
          sessionId
        }),
      });

      if (!res.ok) throw new Error("Request failed");

      const data = await res.json();

      // Update session ID if we got a new one
      if (data.sessionId && data.sessionId !== sessionId) {
        setSessionId(data.sessionId);
        localStorage.setItem("chatSessionId", data.sessionId);
      }

      if (data.redirect) {
        setTimeout(() => {
          window.open(data.redirect, '_blank');
          const aiMessage = {
            id: Date.now().toString(),
            content: `Opening <strong>${data.product || "the page"}</strong> in a new tab...`,
            isUser: false,
            timestamp: new Date(),
          };
          addMessage(aiMessage);
        }, 1000);
        return;
      }

      setTimeout(() => {
        const aiMessage = {
          id: Date.now().toString(),
          content: data.reply,
          isUser: false,
          timestamp: new Date(),
        };
        addMessage(aiMessage);
      }, 800);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Failed to get response";
      setError(errorMessage);

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
      <div className="fixed bottom-8 right-8 z-50 transition-transform duration-300 hover:scale-110 active:scale-95">
        <button
          onClick={toggleChat}
          className="bg-gradient-to-br from-blue-600 to-purple-600 text-white p-4 rounded-full shadow-xl hover:shadow-2xl transition-all duration-300 flex items-center justify-center relative group"
          aria-label="Open chat"
        >
          <MessageCircle size={28} className="transition-transform group-hover:rotate-12" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-full max-w-[calc(100%-2rem)] sm:max-w-md md:max-w-lg lg:max-w-xl xl:max-w-2xl transition-all duration-300 ease-in-out">
      <div className={`w-full ${isMinimized ? "h-16" : "h-[calc(100vh-8rem)] sm:h-[600px]"} bg-white shadow-2xl rounded-2xl overflow-hidden border border-gray-200 flex flex-col transition-all duration-300`}>
        {/* Chat header */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 text-white p-4 flex items-center justify-between rounded-t-xl cursor-pointer" onClick={toggleMinimize}>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="relative">
              <Sparkles className="text-yellow-300 w-6 h-6 sm:w-7 sm:h-7 animate-pulse" />
              <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-400 rounded-full border-2 border-white"></div>
            </div>
            <h2 className="text-lg sm:text-xl font-semibold">Shopping Assistant</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleMinimize}
              className="text-white hover:text-gray-200 transition p-1 rounded-full hover:bg-white/10"
              aria-label={isMinimized ? "Maximize chat" : "Minimize chat"}
            >
              {isMinimized ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
            </button>
            <button
              onClick={toggleChat}
              className="text-white hover:text-gray-200 transition p-1 rounded-full hover:bg-white/10"
              aria-label="Close chat"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {!isMinimized && (
          <>
            {/* Messages area */}
            <div
              id="assistant-chat-area"
              className="flex-1 overflow-y-auto p-4 space-y-4 bg-gradient-to-b from-white via-blue-50 to-blue-100"
            >
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`flex ${message.isUser ? "justify-end" : "justify-start"} transition-all duration-300 ease-out`}
                >
                  <div
                    className={`max-w-[85%] rounded-2xl p-3 sm:p-4 text-sm sm:text-base relative transition-all duration-300 ${message.isUser
                      ? "bg-gradient-to-br from-blue-600 to-blue-500 text-white rounded-br-none shadow-lg"
                      : "bg-white text-gray-800 rounded-bl-none shadow-md border border-gray-100"
                      }`}
                  >
                    {renderMessageContent(message.content)}
                    <div className="absolute bottom-0 right-0 w-3 h-3 overflow-hidden">
                      <div className={`absolute w-4 h-4 rounded-sm ${message.isUser ? "bg-blue-600" : "bg-white"
                        } transform rotate-45 -right-1 -bottom-1 ${message.isUser
                          ? "shadow-[2px_2px_2px_rgba(0,0,0,0.1)]"
                          : "shadow-[1px_1px_1px_rgba(0,0,0,0.1)] border border-gray-100"
                        }`}></div>
                    </div>
                    <p className={`text-xs mt-1 sm:mt-2 ${message.isUser ? "text-blue-100" : "text-gray-500"
                      }`}>
                      {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex justify-start">
                  <div className="bg-white text-gray-800 rounded-2xl rounded-bl-none p-3 sm:p-4 max-w-[85%] shadow-md border border-gray-100">
                    <div className="flex items-center gap-3 sm:gap-4">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-blue-500 animate-bounce" />
                        <div className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-blue-600 animate-bounce delay-100" />
                        <div className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-blue-700 animate-bounce delay-200" />
                      </div>
                      <span className="text-sm sm:text-base font-medium">Generating response...</span>
                    </div>
                  </div>
                </div>
              )}

              {typingIndicator && !loading && (
                <div className="flex justify-start">
                  <div className="bg-white text-gray-800 rounded-2xl rounded-bl-none p-3 sm:p-4 max-w-[85%] shadow-md border border-gray-100">
                    <div className="flex items-center gap-2">
                      <div className="flex space-x-1">
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse" />
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-150" />
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-300" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="border-t border-gray-200 p-4 bg-white shadow-inner rounded-b-xl">
              {error && (
                <div className="mb-2 sm:mb-3 p-3 bg-red-50 text-red-700 rounded-lg text-sm sm:text-base shadow-inner border border-red-100 flex items-start gap-2 transition-all duration-300">
                  <div className="bg-red-100 p-1 rounded-full">
                    <X size={14} className="text-red-600" />
                  </div>
                  {error}
                </div>
              )}
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={
                      pendingAction
                        ? "Type 'yes' to confirm or anything else to cancel"
                        : "Type your message..."
                    }
                    className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm sm:text-base pr-12"
                    disabled={loading}
                  />
                  {input && (
                    <button
                      onClick={() => setInput("")}
                      className="absolute right-16 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <X size={18} />
                    </button>
                  )}
                </div>
                <button
                  onClick={handleSubmit}
                  disabled={loading || !input.trim()}
                  className={`p-3 rounded-xl transition-all duration-200 ${loading || !input.trim()
                    ? "bg-gray-300 text-gray-500"
                    : "bg-gradient-to-br from-blue-600 to-purple-600 text-white hover:shadow-lg hover:scale-105"
                    }`}
                >
                  {loading ? (
                    <RotateCw className="w-5 h-5 sm:w-6 sm:h-6 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5 sm:w-6 sm:h-6" />
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-2 text-center">
                {pendingAction ? "Confirm your action" : "Ask me anything about products, orders, or support"}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default CustomerAssistant;
