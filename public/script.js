document.addEventListener('DOMContentLoaded', () => {

    // --- 1. DOM 元素获取 (不变) ---
    const textInput = document.getElementById('text-input');
    const translateBtn = document.getElementById('translate-text-btn');
    const recordBtn = document.getElementById('record-btn');
    const uploadImageBtn = document.getElementById('upload-image-btn');
    const conversationBtn = document.getElementById('conversation-btn');
    const imageUpload = document.getElementById('image-upload');
    const outputDiv = document.getElementById('translation-output');
    const statusText = document.getElementById('status-text');
    const recordStatus = document.getElementById('record-status');
    const conversationStatus = document.getElementById('conversation-status');
    const sourceLangSelect = document.getElementById('source-lang');
    const targetLangSelect = document.getElementById('target-lang');
    const modelSelect = document.getElementById('model-select');
    const imagePreviewContainer = document.getElementById('image-preview-container');
    const imagePreview = document.getElementById('image-preview');
   const swapLangBtn = document.getElementById('swap-lang-btn');
   const clearInputBtn = document.getElementById('clear-input-btn');
   const deleteImageBtn = document.getElementById('delete-image-btn');
   const clearOutputBtn = document.getElementById('clear-output-btn');


    // --- 2. 文字翻译功能 (不变) ---
   if (translateBtn) {
    translateBtn.addEventListener('click', async () => {
        const text = textInput.value;
        if (!text.trim()) { return alert('请输入要翻译的文字！'); }

        // --- 修改点：在这里启动加载动画 ---
        outputDiv.innerHTML = ''; // 先清空
        outputDiv.classList.add('loading-indicator');
        outputDiv.dataset.loadingText = '翻译中'; // 设置加载文字
        statusText.innerText = ''; // 清空旧的状态文字

        try {
            const response = await fetch('/api/translate-text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text,
                    sourceLang: sourceLangSelect.value,
                    targetLang: targetLangSelect.value,
                    model: modelSelect.value
                }),
            });
            if (!response.ok) { throw new Error((await response.json()).error); }
            const data = await response.json();
            outputDiv.innerText = data.translation; // 填充结果
            statusText.innerText = '翻译完成';
        } catch (error) {
            statusText.innerText = '翻译失败';
            outputDiv.innerText = `错误: ${error.message}`;
        } finally {
            // --- 修改点：无论成功或失败，都移除加载动画 ---
            outputDiv.classList.remove('loading-indicator');
        }
    });
}

    // --- 3. 拍照/上传图片翻译功能 (不变) ---
    if (uploadImageBtn) {
        uploadImageBtn.addEventListener('click', () => imageUpload.click());
    }
if (imageUpload) {
    imageUpload.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        // --- 修改点：在这里启动加载动画 ---
        outputDiv.innerHTML = '';
        outputDiv.classList.add('loading-indicator');
        outputDiv.dataset.loadingText = '图片分析中';
        statusText.innerText = '';

        imagePreviewContainer.style.display = 'flex';
        imagePreview.src = URL.createObjectURL(file);

        try {
            const base64Image = await toBase64(file);
            const response = await fetch('/api/translate-image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: base64Image,
                    model: modelSelect.value,
                    targetLang: targetLangSelect.value
                }),
            });
            if (!response.ok) { throw new Error((await response.json()).error); }
            const data = await response.json();
            outputDiv.innerHTML = formatMarkdown(data.translation);
            statusText.innerText = '图片分析翻译完成';
        } catch (error) {
            statusText.innerText = '图片翻译失败';
            outputDiv.innerText = `错误: ${error.message}`;
        } finally {
            // --- 修改点：无论成功或失败，都移除加载动画 ---
            outputDiv.classList.remove('loading-indicator');
        }
    });
}

    const toBase64 = file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });

    // --- 4. 语音功能总控制 (最终稳定版 V10) ---
    let mediaRecorder;
    let audioChunks = [];
    let isContinuousModeActive = false;
    let continuousInterval = null;
    const CHUNK_DURATION = 4000; // 每4秒处理一次

    // 统一的音频处理函数
    const processAudio = async (blob, isContinuous) => {
        if (!blob || blob.size < 1000) {
            console.log('音频块为空，已跳过。');
            if (isContinuous && isContinuousModeActive) {
                // 如果是持续模式下的空块，直接准备下一次录制
                continuousRecordCycle();
            }
            return;
        }

        const statusTarget = isContinuous ? conversationStatus : statusText;
        statusTarget.innerText = '正在翻译...';
        
        const formData = new FormData();
        const fileExtension = (blob.type.split(';')[0].split('/')[1] || 'webm');
        const filename = `${isContinuous ? 'chunk' : 'single'}.${fileExtension}`;

        formData.append('audio', blob, filename);
        formData.append('targetLang', targetLangSelect.value);
        formData.append('sourceLang', sourceLangSelect.value);
        formData.append('model', modelSelect.value);

        try {
            const response = await fetch('/api/translate-voice', { method: 'POST', body: formData });
            if (!response.ok) { throw new Error((await response.json()).error || '服务器响应错误'); }
            const data = await response.json();
            
            if (isContinuous) {
                outputDiv.innerText += data.translation + ' ';
clearOutputBtn.style.display = 'block';
                if(isContinuousModeActive) continuousRecordCycle(); // 成功后，开始下一轮
            } else {
                textInput.value = `[语音输入]: ${data.transcription}`;
                outputDiv.innerText = data.translation;
                statusTarget.innerText = '翻译完成';
            }
        } catch (error) {
            console.error('音频处理失败:', error);
            statusTarget.innerText = `[翻译错误]`;
            if (isContinuous && isContinuousModeActive) continuousRecordCycle(); // 即使失败，也开始下一轮
        }
    };

    const continuousRecordCycle = () => {
        if (!isContinuousModeActive) return;
        conversationStatus.innerText = '持续翻译中...';
        audioChunks = [];
        mediaRecorder.start();
        // 设置一个定时器，在指定时间后停止录音，触发onstop
        continuousInterval = setTimeout(() => {
            if (mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
        }, CHUNK_DURATION);
    };

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                mediaRecorder = new MediaRecorder(stream);
                
                // “按住说话”功能事件绑定
                recordBtn.addEventListener('mousedown', () => { if(isContinuousModeActive) return; audioChunks = []; mediaRecorder.start(); recordStatus.innerText = '录音中...'; });
                recordBtn.addEventListener('touchstart', (e) => { e.preventDefault(); recordBtn.dispatchEvent(new Event('mousedown')); });
                recordBtn.addEventListener('mouseup', () => { if(isContinuousModeActive || mediaRecorder.state !== 'recording') return; recordStatus.innerText = '录音结束，分析中...'; mediaRecorder.stop(); });
                recordBtn.addEventListener('touchend', (e) => { e.preventDefault(); recordBtn.dispatchEvent(new Event('mouseup')); });
                
                // “持续翻译”功能事件绑定
                conversationBtn.addEventListener('click', () => {
                    isContinuousModeActive = !isContinuousModeActive;
                    if (isContinuousModeActive) {
                        conversationBtn.textContent = '停止持续翻译';
                        conversationBtn.className = 'conversation-btn-stop';
                        [recordBtn, uploadImageBtn, translateBtn].forEach(b => b.disabled = true);
                        outputDiv.innerText = '';
                        continuousRecordCycle(); // 开始第一个循环
                    } else {
                        conversationBtn.textContent = '开始持续翻译';
                        conversationBtn.className = 'conversation-btn-start';
                        [recordBtn, uploadImageBtn, translateBtn].forEach(b => b.disabled = false);
                        conversationStatus.innerText = '';
                        clearTimeout(continuousInterval);
                        if (mediaRecorder.state === 'recording') {
                            mediaRecorder.stop();
                        }
                    }
                });

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) audioChunks.push(event.data);
                };

                mediaRecorder.onstop = () => {
                    const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
                    if (isContinuousModeActive) {
                        processAudio(audioBlob, true);
                    } else {
                        processAudio(audioBlob, false);
                    }
                };
            })
            .catch(err => {
                recordStatus.innerText = '无法访问麦克风。';
                [recordBtn, conversationBtn].forEach(b => b && (b.disabled = true));
            });
    } else {
         recordStatus.innerText = '抱歉，您的浏览器不支持录音功能。';
    }

// ▼▼▼ 请将下面所有代码，粘贴到 script.js 末尾（最后一个});之前） ▼▼▼

// --- 新增功能5：语言交换 ---
if(swapLangBtn) {
    swapLangBtn.addEventListener('click', () => {
        const sourceVal = sourceLangSelect.value;
        const targetVal = targetLangSelect.value;

        if (sourceVal === 'auto') {
            alert('“自动检测”模式无法被设为目标语言。');
            return;
        }
        sourceLangSelect.value = targetVal;
        targetLangSelect.value = sourceVal;
    });
}

// --- 新增功能3：删除图片 ---
if(deleteImageBtn) {
    deleteImageBtn.addEventListener('click', () => {
        imagePreviewContainer.style.display = 'none';
        imagePreview.src = '#';
        imageUpload.value = null; // 允许再次上传同一张图片
    });
}

// --- 新增功能4：Markdown格式化函数 ---
const formatMarkdown = (text) => {
    if (!text) return '';
    // 这个函数将AI返回的特定Markdown格式转换为HTML
    return text
        .replace(/### (.*?)\n---/g, '<h3>$1</h3>')
        .replace(/### (.*)/g, '<h3>$1</h3>')
        .replace(/---/g, '<hr>')
        .replace(/\n/g, '<br>');
};

// --- 新增功能5：输入框清空按钮 ---
if(clearInputBtn && textInput) {
    // 当用户输入时，根据内容决定是否显示清空按钮
    textInput.addEventListener('input', () => {
        clearInputBtn.style.display = textInput.value.length > 0 ? 'block' : 'none';
    });

    // 点击清空按钮的逻辑
    clearInputBtn.addEventListener('click', () => {
        textInput.value = '';
        outputDiv.innerHTML = '';
        statusText.innerText = '';
        clearInputBtn.style.display = 'none';
    });
}

// --- 功能：删除图片 (修复版) ---
if(deleteImageBtn) {
    deleteImageBtn.addEventListener('click', () => {
        console.log('删除图片按钮被点击！'); // 增加调试日志

        imagePreviewContainer.style.display = 'none';
        imagePreview.src = '#';
        imageUpload.value = null; // 允许再次上传同一张图片
    });
}

// --- 功能：清空翻译结果 ---
if(clearOutputBtn) {
    clearOutputBtn.addEventListener('click', () => {
        outputDiv.innerHTML = ''; // 清空内容
        clearOutputBtn.style.display = 'none'; // 隐藏自己
        statusText.innerText = ''; // 清空状态
    });
}
});