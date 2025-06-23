require('dotenv').config(); // 加载 .env 文件中的环境变量
const express = require('express');
const OpenAI = require('openai');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;

// ---- 中间件设置 ----
app.use(cors()); // 允许跨域请求
app.use(express.json({ limit: '10mb' })); // 解析JSON请求体, 增加图片base64编码后的大小限制
app.use(express.static('public')); // 托管 public 文件夹中的静态文件

// ---- OpenAI 初始化 ----
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---- 文件上传设置 ----
// Multer 存储引擎配置
const storage = multer.diskStorage({
  // destination 用于指定文件存放的路径
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  // filename 用于指定文件的名字
  filename: function (req, file, cb) {
    // 直接使用前端上传时提供的原始文件名
    cb(null, file.originalname); 
  }
});

const upload = multer({ storage: storage });
// 确保 uploads 目录存在
if (!fs.existsSync('uploads')) {
    fs.mkdirSync('uploads');
}

// =======================================================
//               API 路由将在这里添加
// --- 功能 1 & 2: 文字翻译路由 ---
app.post('/api/translate-text', async (req, res) => {
    try {
        // --- 核心修改1：接收 model 参数 ---
        const { text, sourceLang, targetLang, model } = req.body;

        if (!text) {
            return res.status(400).json({ error: '翻译文本不能为空' });
        }

        const completion = await openai.chat.completions.create({
            // --- 核心修改2：使用传来的 model，如果没传则使用默认值 ---
            model: model || 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: `You are a professional translator. You will be given text to translate.`
            }, {
                role: 'user',
                content: `Translate the following text from ${sourceLang} to ${targetLang}. If the source language is 'auto', please auto-detect it. Provide only the translated text, without any additional explanations or quotes. The text to translate is: "${text}"`
            }],
        });
        
        const translatedText = completion.choices[0].message.content.trim();
        res.json({ translation: translatedText });

    } catch (error) {
        console.error('文字翻译出错:', error);
        res.status(500).json({ error: '服务器在翻译时发生错误' });
    }
});
// =======================================================

// --- 功能 3: 语音翻译路由 ---
// 'upload.single('audio')' 是一个中间件，它会处理名为 'audio' 的文件上传
app.post('/api/translate-voice', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: '没有接收到音频文件' });
    }

    let finalFilePath; 
    try {
        const { targetLang, model, sourceLang } = req.body;
        
        const fileExt = path.extname(req.file.originalname).toLowerCase();
        const uniqueSuffix = crypto.randomBytes(8).toString('hex');
        const uniqueFileName = `${uniqueSuffix}${fileExt}`;
        finalFilePath = path.join('uploads', uniqueFileName);
        
        fs.renameSync(req.file.path, finalFilePath);
        
        const languageMap = { "Chinese": "zh", "English": "en", "Japanese": "ja", "Korean": "ko", "French": "fr", "German": "de", "Greek": "el" };
        const whisperOptions = {
            model: 'whisper-1',
            file: fs.createReadStream(finalFilePath),
        };
        if (sourceLang && languageMap[sourceLang]) {
            whisperOptions.language = languageMap[sourceLang];
        }
        
        const transcription = await openai.audio.transcriptions.create(whisperOptions);
        const transcribedText = transcription.text;

        // --- ▼▼▼ 核心修复：增加幻觉过滤器 ▼▼▼ ---
        const HALLUCINATION_KEYWORDS = ['amara', 'subtitle', 'thanks for watching', 'caption', 'transcribe'];
        const isHallucination = HALLUCINATION_KEYWORDS.some(keyword => 
            transcribedText.toLowerCase().includes(keyword)
        );

        if (!transcribedText || transcribedText.trim() === '' || isHallucination) {
            console.log(`Whisper 未检测到语音或检测到幻觉，已拦截: "${transcribedText}"`);
            return res.json({
                transcription: '(No speech detected or hallucination)',
                translation: '(未检测到语音)'
            });
        }
        // --- ▲▲▲ 核心修复结束 ▲▲▲ ---

        const translationCompletion = await openai.chat.completions.create({
            model: model || 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: 'You are a professional translator.'
            }, {
                role: 'user',
                content: `Translate the following text to ${targetLang}. The source language is unknown, so please auto-detect it. Provide only the translated text. Text: "${transcribedText}"`
            }],
        });
        const translatedText = translationCompletion.choices[0].message.content.trim();

        res.json({
            transcription: transcribedText,
            translation: translatedText
        });

    } catch (error) {
        console.error('语音翻译出错:', error);
        res.status(500).json({ error: '语音翻译时服务器出错' });
    } finally {
        if (finalFilePath && fs.existsSync(finalFilePath)) {
            fs.unlinkSync(finalFilePath);
            console.log(`已清理临时文件: ${finalFilePath}`);
        }
    }
});

// =======================================================
// 功能4: 图片翻译和解说路由
app.post('/api/translate-image', async (req, res) => {
    try {
        // --- 核心修改1：从请求中接收 targetLang ---
        const { image, model, targetLang } = req.body; 
        if (!image) {
            return res.status(400).json({ error: '没有图片数据' });
        }

        // 如果前端没传，给一个默认值
        const finalTargetLang = targetLang || 'Chinese'; 

        // --- 核心修改2：在指令中使用动态的目标语言 ---
        const visionPrompt = `You are an expert image analyst and translator. Analyze the following image and perform these tasks in order:
1.  **Extract Text**: Identify and extract all text from the image, preserving its original structure if possible.
2.  **Translate**: Translate all the extracted text into ${finalTargetLang}.
3.  **Explain**: Provide a brief explanation in ${finalTargetLang} about the image's content or context. What is it? What might it be used for?

Format your final response strictly as follows, using these exact headings:

### 翻译结果
---
(Your translated text goes here)

### 内容解说
---
(Your explanation in ${finalTargetLang} goes here)`;
        
        const response = await openai.chat.completions.create({
            model: model && model.includes('4') ? model : 'gpt-4.1-2025-04-14',
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: visionPrompt },
                        {
                            type: "image_url",
                            image_url: {
                                "url": image,
                                "detail": "high"
                            },
                        },
                    ],
                },
            ],
            max_tokens: 1500,
        });

        const resultText = response.choices[0].message.content;
        res.json({ translation: resultText });

    } catch (error) {
        console.error('图片翻译出错:', error);
        res.status(500).json({ error: '图片翻译时服务器出错' });
    }
});

// =======================================================
// ---- 启动服务器 ----
app.listen(port, '0.0.0.0', () => {
  console.log(`服务器已启动，请在浏览器中打开 http://localhost:${port}`);
  console.log(`在同一网络下的其他设备上，请访问 http://<你的IP地址>:${port}`);
});