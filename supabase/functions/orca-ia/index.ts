// Supabase Edge Function: orca-ia
// Intermediário entre o app Foster Orça e a Groq. A chave fica só aqui (secret GROQ_API_KEY).
// Secrets:
//   GROQ_API_KEY     = chave da Groq (console.groq.com)
//   ALLOWED_ORIGINS  = (opcional) origens permitidas, separadas por vírgula.
//                      Padrão: fosterfcs.github.io e fostercalc.com.br (e subdomínios)
// Publicar sem exigir login (o app não usa login ainda):  supabase functions deploy orca-ia --no-verify-jwt

const GROQ = "https://api.groq.com/openai/v1";
const MAX_TEXTO = 4000;          // caracteres da fala
const MAX_SYSTEM = 12000;        // catálogo enviado pelo app
const MAX_AUDIO = 8 * 1024 * 1024; // 8 MB (~4 min)

function cors(origin: string | null) {
  const env = (Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = env.length ? env : ["https://fosterfcs.github.io", "https://fostercalc.com.br", "https://www.fostercalc.com.br"];
  const ok = !!origin && (allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.fostercalc\.com\.br$/.test(origin));
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": ok && origin ? origin : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
      "Vary": "Origin",
    },
  };
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const { ok, headers } = cors(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (!ok) return json({ erro: "origem não permitida" }, 403, headers);
  if (req.method !== "POST") return json({ erro: "use POST" }, 405, headers);

  const key = Deno.env.get("GROQ_API_KEY");
  const acao = new URL(req.url).searchParams.get("acao");
  if (acao === "ping") return json({ ok: true, chave: !!key }, 200, headers);
  if (!key) return json({ erro: "IA não configurada" }, 500, headers);

  try {
    if (acao === "interpretar") {
      const { system, texto } = await req.json();
      if (typeof texto !== "string" || !texto.trim()) return json({ erro: "texto vazio" }, 400, headers);
      if (texto.length > MAX_TEXTO || String(system || "").length > MAX_SYSTEM) return json({ erro: "texto muito longo" }, 413, headers);
      const r = await fetch(`${GROQ}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: String(system) }, { role: "user", content: texto }],
        }),
      });
      if (!r.ok) return json({ erro: "falha na IA", status: r.status }, 502, headers);
      const j = await r.json();
      return json(JSON.parse(j.choices[0].message.content), 200, headers);
    }

    if (acao === "transcrever") {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return json({ erro: "áudio ausente" }, 400, headers);
      if (file.size > MAX_AUDIO) return json({ erro: "áudio muito longo" }, 413, headers);
      const fd = new FormData();
      fd.append("file", file, file.name || "audio.webm");
      fd.append("model", "whisper-large-v3-turbo");
      fd.append("language", "pt");
      const r = await fetch(`${GROQ}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
      if (!r.ok) return json({ erro: "falha na transcrição", status: r.status }, 502, headers);
      const j = await r.json();
      return json({ text: j.text || "" }, 200, headers);
    }

    return json({ erro: "ação inválida" }, 400, headers);
  } catch (e) {
    return json({ erro: "erro interno", detalhe: String(e) }, 500, headers);
  }
});
