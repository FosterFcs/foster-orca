// Central de pagamentos Foster: gera a cobrança Pix no Asaas para um pedido de um app.
// O app chama com o token do usuário logado: POST { produto: "orca" | "academia" | "obras", codigo, cpf?, nome? }  (cpf aceita CPF ou CNPJ)
// A cobrança leva externalReference "fosterorca:<codigo>", "academia:<codigo>" ou "fosterobras:<codigo>";
// quando o Asaas avisa o pagamento, a função asaas-webhook confirma o pedido sozinha.
// Segredos: ASAAS_API_KEY (o mesmo do webhook).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const API = "https://api.asaas.com/v3";
const PRODUTOS: Record<string, { tabela: string; ref: string; descricao: (p: any) => string }> = {
  orca: { tabela: "orca_pagamentos", ref: "fosterorca",
    descricao: (p) => `Foster Orça - plano Profissional ${p.plano === "anual" ? "anual" : "mensal"} (${p.codigo})` },
  academia: { tabela: "acad_compras", ref: "academia",
    descricao: (p) => `Academia Foster - ${p.creditos} certificado${p.creditos > 1 ? "s" : ""} (${p.codigo})` },
  obras: { tabela: "obra_pagamentos", ref: "fosterobras",
    descricao: (p) => `Foster Obras - plano ${({ basico: "Básico", profissional: "Profissional", empresa: "Empresa" } as any)[p.plano] || p.plano} mensal (${p.codigo})` },
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const resp = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const limpar = (s: string) => s.trim().replace(/^["']+|["']+$/g, "").trim();

function cpfValido(c: string) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +c[9] && dv(10) === +c[10];
}
function cnpjValido(c: string) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const dv = (n: number) => { const pesos = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; let s = 0; for (let i = 0; i < n; i++) s += +c[i] * pesos[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +c[12] && dv(13) === +c[13];
}
function vencimento(dias: number) {
  const d = new Date(Date.now() - 3 * 3600e3 + dias * 864e5); // horário de Brasília
  return d.toISOString().slice(0, 10);
}

async function asaas(caminho: string, init: RequestInit = {}) {
  const chave = limpar(Deno.env.get("ASAAS_API_KEY") || "");
  if (!chave) throw new Error("ASAAS_API_KEY não configurada");
  const r = await fetch(API + caminho, { ...init, headers: { access_token: chave, "Content-Type": "application/json", "User-Agent": "FosterCentral", ...(init.headers || {}) } });
  const t = await r.text(); let j: any = null; try { j = t ? JSON.parse(t) : null; } catch { /* */ }
  if (!r.ok) { console.log(JSON.stringify({ diag: "asaas", caminho: caminho.split("?")[0], status: r.status, erro: j?.errors?.[0]?.description })); const e: any = new Error(j?.errors?.[0]?.description || `Asaas ${r.status}`); e.status = r.status; throw e; }
  return j;
}
async function qrDe(pagamentoId: string) {
  try { const q = await asaas(`/payments/${pagamentoId}/pixQrCode`); return { payload: q.payload, imagem: q.encodedImage, expira: q.expirationDate }; }
  catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return resp({ erro: "metodo" }, 405);
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // usuário logado
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: ud } = token ? await sb.auth.getUser(token) : { data: null as any };
  const user = ud?.user;
  if (!user) return resp({ erro: "login_necessario" }, 401);

  let body: any = {}; try { body = await req.json(); } catch { /* */ }
  const prod = PRODUTOS[body.produto];
  const codigo = String(body.codigo || "").trim().toUpperCase();
  if (!prod || !codigo) return resp({ erro: "pedido_invalido" }, 400);

  try {
    const { data: ped } = await sb.from(prod.tabela).select("*").eq("codigo", codigo).eq("user_id", user.id).maybeSingle();
    if (!ped) return resp({ erro: "pedido_nao_encontrado" }, 404);
    if (ped.status === "pago") return resp({ pago: true });
    if (ped.status !== "pendente") return resp({ erro: "pedido_encerrado" }, 409);

    // cobrança já criada para este pedido: reaproveita enquanto estiver em aberto
    if (ped.asaas_id) {
      const pg = await asaas(`/payments/${ped.asaas_id}`).catch(() => null);
      if (pg && ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(pg.status)) return resp({ pago: true, aguardando: true });
      if (pg && !pg.deleted && pg.status === "PENDING") {
        const qr = await qrDe(ped.asaas_id);
        if (qr) return resp({ codigo, valor: ped.valor, pix: qr, url: ped.asaas_url });
      }
    }

    // cliente no Asaas (um por usuário, vale para todos os apps)
    let { data: cli } = await sb.from("asaas_clientes").select("*").eq("user_id", user.id).maybeSingle();
    if (!cli) {
      let cpf = String(body.cpf || "").replace(/\D/g, "");
      if (!cpf && body.produto === "academia") {
        const { data: c } = await sb.from("acad_certificados").select("cpf").eq("user_id", user.id).order("solicitado_em", { ascending: false }).limit(1).maybeSingle();
        cpf = c?.cpf || "";
      }
      if (!cpf) return resp({ precisa_cpf: true });
      if (!(cpf.length === 14 ? cnpjValido(cpf) : cpfValido(cpf))) return resp({ erro: "cpf_invalido" }, 400);
      const nome = String(body.nome || user.user_metadata?.nome || "").trim().slice(0, 100) || String(user.email || "Cliente").split("@")[0];
      const achado = await asaas(`/customers?cpfCnpj=${cpf}&limit=1`);
      let clienteId = achado?.data?.[0]?.id;
      if (!clienteId) {
        const novo = await asaas("/customers", { method: "POST", body: JSON.stringify({ name: nome, email: user.email, cpfCnpj: cpf, externalReference: user.id, notificationDisabled: true }) });
        clienteId = novo.id;
      }
      await sb.from("asaas_clientes").upsert({ user_id: user.id, cliente_id: clienteId, cpf });
      cli = { cliente_id: clienteId };
    }

    const pg = await asaas("/payments", { method: "POST", body: JSON.stringify({
      customer: cli.cliente_id, billingType: "PIX", value: Number(ped.valor), dueDate: vencimento(3),
      description: prod.descricao(ped), externalReference: `${prod.ref}:${codigo}` }) });
    await sb.from(prod.tabela).update({ asaas_id: pg.id, asaas_url: pg.invoiceUrl }).eq("codigo", codigo);
    const qr = await qrDe(pg.id);
    return resp({ codigo, valor: ped.valor, pix: qr, url: pg.invoiceUrl });
  } catch (e) {
    console.error("asaas-cobrar", String(e));
    const msg = String((e as Error).message || "");
    if (/cpf|cnpj/i.test(msg)) return resp({ erro: "cpf_invalido" }, 400);
    return resp({ erro: "falha_asaas" }, 502);
  }
});
