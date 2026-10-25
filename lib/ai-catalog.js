/* The Workers AI catalog wired into Meechie's World (owner: "install all AI models available
 * on Cloudflare on my website"). Models are not files you install — they run in Cloudflare's
 * cloud and the site calls them through the AI binding. This file is the single list the
 * gateway (functions/api/ai.js) will run; anything not listed here cannot be called.
 * IDs verified against developers.cloudflare.com/workers-ai/models on 2026-10-25.
 * Kinds: chat, reasoning, code, vision (chat-shaped), image (prompt → picture),
 * stt (audio → text), tts (text → audio), embed, rerank, translate, safety, classify. */
export const MODELS = [
  // ---- brains: chat ----
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B", kind: "chat", note: "Smartest all-round brain. Meechie's default." },
  { id: "@cf/meta/llama-3.1-8b-instruct", name: "Llama 3.1 8B", kind: "chat", note: "Fast everyday chat." },
  { id: "@cf/meta/llama-3.2-3b-instruct", name: "Llama 3.2 3B", kind: "chat", note: "Smallest and quickest." },
  { id: "@cf/meta/llama-3.2-1b-instruct", name: "Llama 3.2 1B", kind: "chat", note: "Tiny, instant answers." },
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout", kind: "chat", note: "Meta's multimodal MoE brain; understands images too." },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", name: "Mistral Small 3.1", kind: "chat", note: "Mistral's 24B chat + vision brain." },
  { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", kind: "chat", note: "DeepSeek's fast multimodal MoE brain. From the owner's list." },
  { id: "@cf/daily-co/phonellm-mini-alpha-2", name: "PhoneLLM Mini", kind: "chat", note: "Tuned for voice agents and phone-style chat. From the owner's list." },
  // ---- specialist decision models (API-only; they answer typed questions against a schema) ----
  { id: "@cf/cloudflare/clef-omni", name: "Clef Omni", kind: "decide", note: "Cloudflare's multimodal decision model. From the owner's list." },
  { id: "@cf/cloudflare/clairic", name: "Clairic", kind: "decide", note: "Extracts, computes and forecasts values with confidence scores. From the owner's list." },
  // ---- brains: deep reasoning ----
  { id: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", name: "DeepSeek R1 Distill 32B", kind: "reasoning", note: "Thinks step by step; strong at hard problems." },
  { id: "@cf/qwen/qwq-32b", name: "QwQ 32B", kind: "reasoning", note: "Qwen's reasoning model." },
  { id: "@cf/openai/gpt-oss-120b", name: "GPT-OSS 120B", kind: "reasoning", note: "OpenAI's big open-weight reasoning model." },
  { id: "@cf/openai/gpt-oss-20b", name: "GPT-OSS 20B", kind: "reasoning", note: "OpenAI's faster open-weight model." },
  // ---- brains: code ----
  { id: "@cf/qwen/qwen2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B", kind: "code", note: "Writes and explains code." },
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B", kind: "code", note: "Qwen3 MoE; strong at code and agents." },
  // ---- vision: talk about pictures ----
  { id: "@cf/meta/llama-3.2-11b-vision-instruct", name: "Llama 3.2 Vision 11B", kind: "vision", note: "Reads images: captions, questions, reasoning." },
  { id: "@cf/llava-hf/llava-1.5-7b-hf", name: "LLaVA 1.5 7B", kind: "vision", note: "Image-to-text chat." },
  // ---- image makers ----
  { id: "@cf/black-forest-labs/flux-1-schnell", name: "FLUX.1 Schnell", kind: "image", note: "Fast, high-quality text-to-image." },
  { id: "@cf/black-forest-labs/flux-2-dev", name: "FLUX.2 Dev", kind: "image", note: "Newest FLUX; realistic, detailed images." },
  { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", name: "Stable Diffusion XL", kind: "image", note: "Classic SDXL image generation." },
  { id: "@cf/bytedance/stable-diffusion-xl-lightning", name: "SDXL Lightning", kind: "image", note: "SDXL at lightning speed." },
  { id: "@cf/lykon/dreamshaper-8-lcm", name: "DreamShaper 8", kind: "image", note: "Photoreal-leaning Stable Diffusion." },
  // ---- ears: speech to text ----
  { id: "@cf/openai/whisper", name: "Whisper", kind: "stt", note: "Transcribes audio in many languages." },
  { id: "@cf/openai/whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", kind: "stt", note: "Fastest accurate transcription." },
  { id: "@cf/openai/whisper-tiny-en", name: "Whisper Tiny (English)", kind: "stt", note: "Light English transcription." },
  { id: "@cf/deepgram/nova-3", name: "Deepgram Nova-3", kind: "stt", note: "Deepgram's speech-to-text." },
  // ---- voice: text to speech ----
  { id: "@cf/myshell-ai/melotts", name: "MeloTTS", kind: "tts", note: "Speaks text aloud in several languages." },
  { id: "@cf/deepgram/aura-1", name: "Deepgram Aura", kind: "tts", note: "Natural, expressive text-to-speech." },
  // ---- language plumbing ----
  { id: "@cf/baai/bge-small-en-v1.5", name: "BGE Small", kind: "embed", note: "Turns text into vectors for search and matching." },
  { id: "@cf/baai/bge-base-en-v1.5", name: "BGE Base", kind: "embed", note: "Balanced text embeddings." },
  { id: "@cf/baai/bge-large-en-v1.5", name: "BGE Large", kind: "embed", note: "Sharpest text embeddings." },
  { id: "@cf/baai/bge-m3", name: "BGE M3", kind: "embed", note: "Multilingual embeddings." },
  { id: "@cf/baai/bge-reranker-base", name: "BGE Reranker", kind: "rerank", note: "Scores how relevant a text is to a question." },
  { id: "@cf/meta/m2m100-1.2b", name: "M2M100", kind: "translate", note: "Translates between 100 languages." },
  // ---- safety + sight ----
  { id: "@cf/meta/llama-guard-3-8b", name: "Llama Guard 3", kind: "safety", note: "Classifies text as safe or unsafe, with categories." },
  { id: "@cf/microsoft/resnet-50", name: "ResNet-50", kind: "classify", note: "Labels what is in an image." },
];
export const MODEL_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m]));
export const DEFAULT_CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
