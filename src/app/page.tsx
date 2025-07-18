"use client";

import React, { useState, useEffect, useRef } from "react";
import { Sparkles, Send, RotateCw, X, MessageCircle } from "lucide-react";
import DOMPurify from 'dompurify';
import { useRouter } from 'next/navigation';

interface Message {
  id: string;
  content: string;
  isUser: boolean;
  timestamp: Date;
}

const CustomerAssistant = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const toggleChat = () => {
    setIsOpen(!isOpen);
    // Persist chat open state
    if (!isOpen) {
      sessionStorage.setItem('chatOpen', 'true');
    } else {
      sessionStorage.removeItem('chatOpen');
    }
  };

  const addMessage = (message: Message) => {
    setMessages(prev => [...prev, message]);
  };

  // Add global addToCartAndCheckout function
  useEffect(() => {
    (window as any).addToCartAndCheckout = (productId: number) => {
      console.log('Buy Now clicked for product ID:', productId);
      // Direct redirect to add-to-cart URL - this bypasses CORS issues
      window.location.href = `http://plugin.ijkstaging.com/shop/?add-to-cart=${productId}`;
    };
    
    console.log('addToCartAndCheckout function attached to window');
    
    return () => {
      delete (window as any).addToCartAndCheckout;
    };
  }, []);

  // Add starting message when the chat is opened
  useEffect(() => {
    // Check if the chat is open and there are no messages yet
    if (isOpen && messages.length === 0) {
      // Only add if there isn't already a welcome message
      const hasWelcomeMessage = messages.some(msg => 
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

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Restore chat state from sessionStorage on component mount
  useEffect(() => {
    const savedMessages = sessionStorage.getItem('chatMessages');
    const chatOpen = sessionStorage.getItem('chatOpen');
    
    if (savedMessages) {
      const parsedMessages = JSON.parse(savedMessages);
      // Convert string timestamps back to Date objects
      const messagesWithDates = parsedMessages.map((msg: any) => ({
        ...msg,
        timestamp: new Date(msg.timestamp)
      }));
      setMessages(messagesWithDates);
      sessionStorage.removeItem('chatMessages');
    }
    
    if (chatOpen) {
      setIsOpen(true);
    }
  }, []);

  const renderMessageContent = (content: string) => {
    const sanitized = DOMPurify.sanitize(content, {
      ADD_TAGS: ['img', 'button'],
      ADD_ATTR: ['style', 'src', 'alt', 'onclick']
    });
    return <div dangerouslySetInnerHTML={{ __html: sanitized }} />;
  };

  const handleSubmit = async () => {
    if (!input.trim()) {
      setError("Please enter a message");
      return;
    }

    const userMessage = {
      id: Date.now().toString(),
      content: input,
      isUser: true,
      timestamp: new Date()
    };

    addMessage(userMessage);
    setInput("");
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/customer-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input,
          history: messages.filter(m => !m.isUser).map(m => ({
            role: "assistant",
            content: m.content
          }))
        }),
      });

      if (!res.ok) throw new Error("Network response was not ok");

      const data = await res.json();

      // Handle addToCart from backend (confirmation flow)
      if (data.addToCart) {
        const cart = JSON.parse(localStorage.getItem('cart') || '[]');
        if (!cart.some((item: any) => item.id === data.addToCart.id)) {
          cart.push(data.addToCart);
          localStorage.setItem('cart', JSON.stringify(cart));
          addMessage({
            id: Date.now().toString(),
            content: `<span style="color:green;">Added <b>${data.addToCart.title}</b> to your cart!</span>`,
            isUser: false,
            timestamp: new Date()
          });
        } else {
          addMessage({
            id: Date.now().toString(),
            content: `<span style="color:orange;">${data.addToCart.title} is already in your cart.</span>`,
            isUser: false,
            timestamp: new Date()
          });
        }
        return;
      }

      if (data.redirect) {
        const aiMessage = {
          id: Date.now().toString(),
          content: data.reply,
          isUser: false,
          timestamp: new Date()
        };
        addMessage(aiMessage);

        // Store messages in sessionStorage before redirecting
        sessionStorage.setItem('chatMessages', JSON.stringify([
          ...messages,
          userMessage,
          aiMessage
        ]));
        sessionStorage.setItem('chatOpen', 'true');

        setTimeout(() => {
          window.location.href = data.redirect;
        }, 1500);
        return;
      }

      const aiMessage = {
        id: Date.now().toString(),
        content: data.reply,
        isUser: false,
        timestamp: new Date()
      };
      addMessage(aiMessage);

    } catch (err) {
      setError("Failed to get response. Please try again.");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Intercept clicks on product card links
  useEffect(() => {
    const handleLinkClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'A' && target.closest('.assistant-product-link')) {
        e.preventDefault();
        const href = (target as HTMLAnchorElement).getAttribute('href');
        if (href) {
          // Persist chat state
          sessionStorage.setItem('chatMessages', JSON.stringify(messages));
          sessionStorage.setItem('chatOpen', 'true');
          router.push(href);
        }
      }
    };
    const chatArea = document.getElementById('assistant-chat-area');
    if (chatArea) {
      chatArea.addEventListener('click', handleLinkClick);
    }
    return () => {
      if (chatArea) {
        chatArea.removeEventListener('click', handleLinkClick);
      }
    };
  }, [messages, router]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
      <div className="w-full h-[calc(100vh-8rem)] sm:h-[600px] bg-gradient-to-t from-white via-blue-50 to-blue-100 shadow-xl rounded-2xl overflow-hidden border border-gray-300 flex flex-col transition-all duration-300 ease-in-out transform hover:scale-105">
        {/* Chat header */}
        <div className="bg-blue-600 text-white p-4 flex items-center justify-between rounded-t-xl transition-all duration-300 ease-in-out hover:bg-blue-700">
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
        <div id="assistant-chat-area" className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.isUser ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-xl p-3 sm:p-4 text-sm sm:text-base transition-all duration-300 ease-in-out ${message.isUser
                  ? 'bg-blue-600 text-white rounded-br-none shadow-lg'
                  : 'bg-gray-100 text-gray-800 rounded-bl-none shadow-md'}`}
              >
                {!message.isUser ? (
                  renderMessageContent(message.content.replace(/\u003ca /g, '\u003ca class="assistant-product-link" '))
                ) : (
                  <p>{message.content}</p>
                )}
                <p className="text-xs opacity-70 mt-1 sm:mt-2">
                  {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
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
              placeholder="Type your message..."
              className="flex-1 px-4 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm sm:text-base transition-all duration-300"
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