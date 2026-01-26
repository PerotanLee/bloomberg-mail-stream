
/**
 * Translates text using Gemini API
 * @param {string} text 
 * @param {string} apiKey 
 * @returns {Promise<string>}
 */
export async function translateWithGemini(text, apiKey) {
    if (!apiKey) return "API key missing";

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const prompt = `Translate the following email content into natural business Japanese. Output ONLY the translation, no introductory text.\n\n${text}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: prompt }]
                }]
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error("Gemini API Error:", data.error);
            return `Translation Error: ${data.error.message || data.error.status}`;
        }

        return data.candidates?.[0]?.content?.parts?.[0]?.text || "Translation returned empty";
    } catch (e) {
        console.error("Gemini Network/Format Error:", e);
        return `Translation Network Error: ${e.message}`;
    }
}
