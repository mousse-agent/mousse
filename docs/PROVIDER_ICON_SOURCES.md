# Provider picker icon sources

`src/renderer/lib/providerIcons.tsx` renders only vectors whose geometry was
obtained from an official company asset. All other provider IDs deliberately
use the component's neutral initial monogram until an official asset can be
verified and added.

| Provider IDs | Treatment | Official source |
| --- | --- | --- |
| `openai`, `openai-codex` | Exact OpenAI Blossom vector | [OpenAI Design Guidelines](https://openai.com/brand/) and the [Blossom SVG served by that page](https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg?q=90&w=3840) |
| `anthropic` | Exact Anthropic symbol vector | [Anthropic Press Kit](https://www.anthropic.com/press-kit) |
| Google/Gemini/Vertex, OpenRouter, DeepSeek, xAI/Grok, Mistral, Groq, Meta/Llama, Cohere, Cursor, and unknown providers | Neutral monogram | No official vector/image asset was verified for this repository task. |

The OpenAI and Anthropic marks use `currentColor` only so the picker can honor
its existing theme; their path geometry is otherwise unmodified.
