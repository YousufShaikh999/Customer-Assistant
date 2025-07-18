// context/ChatContext.tsx
"use client";

import { createContext, useContext, useState, ReactNode, useEffect } from "react";

interface Message {
    id: string;
    content: string;
    isUser: boolean;
    timestamp: Date | string;
}

interface ChatContextType {
    isOpen: boolean;
    toggleChat: () => void;
    messages: Message[];
    addMessage: (message: Message) => void;
    clearMessages: () => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<Message[]>([]);
    const [initialized, setInitialized] = useState(false);

    // Initialize messages from storage and add welcome message if empty
    useEffect(() => {
        if (initialized) return;
        
        let loadedMessages: Message[] = [];
        
        if (typeof window !== 'undefined') {
            const saved = sessionStorage.getItem('chatMessages') || localStorage.getItem('chatMessages');
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    loadedMessages = parsed.map((msg: any) => ({
                        ...msg,
                        timestamp: new Date(msg.timestamp)
                    }));
                } catch (e) {
                    console.error("Failed to parse chat messages", e);
                }
            }
        }

        // If no messages exist, add welcome message
        if (loadedMessages.length === 0) {
            loadedMessages = [{
                id: Date.now().toString(),
                content: "Hello! How can I assist you today?",
                isUser: false,
                timestamp: new Date(),
            }];
        }

        setMessages(loadedMessages);
        setInitialized(true);
    }, [initialized]);

    const addMessage = (message: Message) => {
        setMessages(prev => [...prev, {
            ...message,
            timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp)
        }]);
    };

    const toggleChat = () => setIsOpen(prev => !prev);

    const clearMessages = () => {
        setMessages([{
            id: Date.now().toString(),
            content: "Hello! How can I assist you today?",
            isUser: false,
            timestamp: new Date(),
        }]);
    };

    // Persist messages to storage
    useEffect(() => {
        if (!initialized) return;
        const toStore = messages.map(msg => ({
            ...msg,
            timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp
        }));
        sessionStorage.setItem('chatMessages', JSON.stringify(toStore));
    }, [messages, initialized]);

    return (
        <ChatContext.Provider value={{ isOpen, toggleChat, messages, addMessage, clearMessages }}>
            {children}
        </ChatContext.Provider>
    );
};

export const useChat = () => {
    const context = useContext(ChatContext);
    if (context === undefined) {
        throw new Error("useChat must be used within a ChatProvider");
    }
    return context;
};