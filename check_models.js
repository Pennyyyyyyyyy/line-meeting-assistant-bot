// check_models.js
require('dotenv').config();
const fetch = require('node-fetch');

const API_KEY = process.env.GEMINI_API_KEY;
const URL = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;

async function listModels() {
    try {
        console.log('正在查詢您的 API Key 可用的模型列表...');
        const response = await fetch(URL);
        const data = await response.json();

        if (data.models) {
            console.log('✅ 可用模型如下：');
            data.models.forEach(m => {
                // 只印出支援 generateContent 的模型
                if (m.supportedGenerationMethods.includes('generateContent')) {
                    console.log(`- ${m.name.replace('models/', '')}`);
                }
            });
        } else {
            console.error('❌ 查詢失敗，回應：', data);
        }
    } catch (error) {
        console.error('❌ 連線錯誤：', error);
    }
}

listModels();