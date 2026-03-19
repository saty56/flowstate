const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Gemini
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
// gemini-2.0-flash is the best for fast coaching responses
const model = genAI ? genAI.getGenerativeModel({ model: "gemini-2.0-flash" }) : null;

// Tone persona descriptors
const TONE_PERSONAS = {
    cheerleader: `You are an ultra-high energy accountability coach. 
    Use celebration language and genuine excitement. Focus on dopamine-driven wins.
    If they are stuck, acknowledge the struggle but pivot quickly to the NEXT small step.`,
    coach: `You are a high-performance elite coach. 
    Direct, efficient, and deeply professional. Match the energy of a high-end personal trainer.
    Use terms of their craft (e.g. if they are coding, talk about Logic and Flow). Keep it moving.`,
    gentle: `You are a mindful, patient companion for the neurodivergent brain. 
    Acknowledge the weight of the "wall of awful" (starting is hard). Use zero-pressure language.
    Sound like a wise, calm friend who understands Executive Dysfunction deeply.`,
};

/**
 * Generate an AI check-in message based on session context
 * @param {object} params - session, user, messageHistory
 */
async function generateCheckin(params) {
    const { user, session, stage, messageHistory = [], customInstruction } = params;

    // IF NO API KEY: Return fallback immediately (Demo Mode)
    if (!model) return getFallbackMessage(stage, session?.goal);

    const persona = TONE_PERSONAS[user.tone_preference] || TONE_PERSONAS.coach;
    const recentHistory = messageHistory.slice(-6).map(m =>
        `${m.direction === 'outgoing' ? 'You' : user.name}: ${m.content}`
    ).join('\n');

    const systemPrompt = `${persona}
    
    CONTEXT:
    - User's name: ${user.name}
    - Their work: ${user.work_type || 'freelance work'}
    - They typically get stuck on: ${(user.stuck_points || []).join(', ') || 'getting started'}
    - Current session goal: "${session?.goal || 'their work'}"
    - Stage: ${stage}
    
    RULES:
    - Keep messages SHORT (1-2 sentences max for SMS)
    - Match their Tone and Craft: If they are a ${user.work_type}, use terms from that trade.
    - Suggest Countermoves: If they are stuck on ${user.stuck_points?.join(', ') || 'starting'}, suggest a tiny specific win to break that cycle.
    - Overcome the Wall of Awful: Starting is the hardest part — lead with it.
    - NEVER use more than 140 characters. End with a sharp action.`;

    const userPrompt = customInstruction || getStagePrompt(stage, user, session);

    try {
        const result = await model.generateContent([
            { text: systemPrompt },
            { text: `Recent conversation:\n${recentHistory || 'No previous messages.'}` },
            { text: `Current Task: ${userPrompt}` }
        ]);

        return result.response.text().trim();
    } catch (err) {
        console.error('❌ Gemini Error:', err.message);
        return getFallbackMessage(stage, session?.goal);
    }
}

function getStagePrompt(stage, user, session) {
    const prompts = {
        morning_checkin: `Ask ${user.name} what their ONE priority is today.`,
        awaiting_time: `${user.name} said their goal is: "${session?.goal}". Ask them what time they will work on it today.`,
        session_start: `Time for session: "${session?.goal}". Ask if they're ready to start.`,
        session_checkin: `Mid-session check-in for: "${session?.goal}". Briefly check if they are still focused.`,
        session_end: `Session for "${session?.goal}" is done. Ask what was accomplished.`,
        celebration: `Celebrate their completion of "${session?.goal}". They accomplished: "${session?.accomplishments}".`,
        missed_session: `They missed their session for "${session?.goal}". Offer to reschedule gently.`,
    };
    return prompts[stage] || `Send a quick check-in to ${user.name}.`;
}

function getFallbackMessage(stage, goal) {
    const fallbacks = {
        morning_checkin: "Good morning! What's your ONE priority today? 🎯",
        session_start: `Time to work on "${goal}". Ready to start?\n\nReply: Yes / Need 5 min`,
        session_checkin: `Checking in! You still focused on "${goal}"? 💪`,
        session_end: `Session done! What did you accomplish?`,
        missed_session: `Hey, I missed you today. Want to reschedule?`,
        celebration: `That's great progress! Keep it up. 🌟`,
    };
    return fallbacks[stage] || 'How is your work going today?';
}

/**
 * Generate the weekly recap message
 */
async function generateWeeklyRecap(user, stats) {
    if (!model) return `Weekly recap: You completed ${stats.sessionsThisWeek} sessions this week. Great job!`;

    try {
        const result = await model.generateContent(`
            You are a ${user.tone_preference} coach. 
            Write a 2-sentence summary for ${user.name}:
            - Completed ${stats.sessionsThisWeek} sessions this week.
            - Previous week: ${stats.sessionsLastWeek}.
            Keep it motivating and under 160 characters.
        `);
        return result.response.text().trim();
    } catch (err) {
        return `Weekly recap: ${stats.sessionsThisWeek} sessions done! You're making progress. 💪`;
    }
}

/**
 * Parse user intent from a text message (Simplified for Demo)
 */
async function parseUserIntent(message, context) {
    if (!model) {
        // Simple Demo logic
        const lower = message.toLowerCase();
        if (['yes', 'y', 'ready', 'yep'].some(w => lower.includes(w))) return { intent: 'yes', confidence: 1 };
        if (['no', 'n', 'can\'t', 'cant'].some(w => lower.includes(w))) return { intent: 'cant_today', confidence: 1 };
        return { intent: 'provide_goal', extractedInfo: message, confidence: 0.8 };
    }

    try {
        const result = await model.generateContent({
            contents: [{
                role: "user",
                parts: [{
                    text: `Analyze this SMS from a user in a "${context.stage}" stage: "${message}".
                    Classify as: yes, no, need_5min, cant_today, provide_goal, provide_time, provide_accomplishment.
                    Return ONLY a JSON object: {"intent": "...", "extractedInfo": "..."}`
                }]
            }]
        });

        const text = result.response.text();
        const jsonMatch = text.match(/\{.*\}/s);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : { intent: 'unclear' };
    } catch (err) {
        return { intent: 'unclear' };
    }
}

/**
 * Rate user focus based on their accomplishments (1-10)
 */
async function rateUserFocus(accomplishments, goal) {
    if (!model) return 7; // Default for demo

    try {
        const result = await model.generateContent(`
            Goal: "${goal}"
            Accomplishments: "${accomplishments}"
            
            On a scale of 1-10, how focused and productive was the user? 
            - 1: No progress or highly distracted.
            - 5: Moderate progress.
            - 10: Outstanding focus, goal achieved.
            
            Return ONLY a JSON object: {"rating": 8}. No other text.
        `);
        const text = result.response.text().trim();
        const jsonMatch = text.match(/\{.*\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            return data.rating || 7;
        }
        return parseInt(text.replace(/[^0-9]/g, '')) || 7;
    } catch (err) {
        console.error('❌ rateUserFocus Error:', err.message);
        return 7;
    }
}

module.exports = { generateCheckin, generateWeeklyRecap, parseUserIntent, rateUserFocus };

