import { NextRequest, NextResponse } from 'next/server';
import { sessions } from '../route'; // Import your sessions store

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sessionId } = body;

    if (!sessionId || !sessions.has(sessionId)) {
      return NextResponse.json(
        { error: 'Invalid session ID' },
        { status: 400 }
      );
    }

    // Refresh the session
    const session = sessions.get(sessionId)!;
    session.updatedAt = Date.now();
    
    // Clear existing timeout and set new one
    if (session.timeout) clearTimeout(session.timeout);
    session.timeout = setTimeout(() => {
      sessions.delete(sessionId);
    }, 5 * 60 * 1000); // 5 minutes

    return NextResponse.json({
      success: true,
      newSessionId: sessionId // Can return a new ID if you want to rotate
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}