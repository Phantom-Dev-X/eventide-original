import https from 'https';

const prompt = 'Explain quantum computing in 1 sentence';
const system = 'Act like a pirate support agent';

const encodedPrompt = encodeURIComponent(prompt);
const systemParam = system ? `&system=${encodeURIComponent(system)}` : '';
// Using the new unified gen.pollinations.ai gateway!
const url = `https://gen.pollinations.ai/text/${encodedPrompt}?model=openai${systemParam}`;

console.log('Testing GET gen.pollinations.ai API...');
console.log('URL:', url);

const req = https.get(url, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        console.log('Status Code:', res.statusCode);
        console.log('Response Headers:', res.headers['content-type']);
        console.log('Body:', data);
    });
});
req.on('error', (err) => {
    console.error('Error:', err);
});
