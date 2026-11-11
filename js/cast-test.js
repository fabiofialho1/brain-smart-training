// Controller (phone) side of the Cast Presentation API smoke test.
// Sends a ping 10 times per second to the page running on the TV and measures the round trip.

const $ = (id) => document.getElementById(id);
const PING_MS = 100;

const diag = {
  navegador: '', webview: '', contextoSeguro: String(window.isSecureContext), presentationApi: 'PresentationRequest' in window ? 'sim' : 'NÃO',
  disponibilidade: 'não verificada', ultimoErro: '-',
};

function describeBrowser() {
  const ua = navigator.userAgent;
  const chrome = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? 'não é Chrome';
  const android = /Android ([\d.]+)/.exec(ua)?.[1] ?? '?';
  diag.navegador = `Chrome ${chrome} · Android ${android}`;
  // WebView / in-app browsers hide the Cast picker; "wv" is in the user agent of Android WebView.
  diag.webview = /; wv\)/.test(ua) || /(FBAN|FBAV|Instagram|Line\/|MicroMessenger|Claude)/i.test(ua)
    ? 'SIM (provavelmente um navegador dentro de outro app: abra no Chrome)' : 'não';
}

function showDiag() {
  $('diag').textContent = Object.entries(diag).map(([k, v]) => `${k}: ${v}`).join('\n');
}

let connection = null;
let timer = null;
let seq = 0;
const rtts = [];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

function report() {
  if (rtts.length === 0) return;
  const recent = rtts.slice(-50);
  const sorted = [...recent].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  $('rtt').textContent = `Ida e volta: mediana ${median(recent).toFixed(0)} ms · p95 ${p95.toFixed(0)} ms · máx ${Math.max(...recent).toFixed(0)} ms · ${rtts.length} respostas`
    + ` (o atraso de ida é cerca de metade)`;
}

function attach(conn) {
  connection = conn;
  conn.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'pong') {
        rtts.push(performance.now() - msg.t);
        report();
      }
    } catch { /* ignore */ }
  };
  conn.onclose = () => stop('Conexão encerrada pela TV.');
  conn.onterminate = () => stop('Apresentação terminada.');
  $('status').textContent = 'Conectado à TV. Enviando mensagens…';
  $('stop').disabled = false;
  timer = setInterval(() => {
    if (connection?.state === 'connected') connection.send(JSON.stringify({ type: 'ping', n: ++seq, t: performance.now() }));
  }, PING_MS);
}

function stop(message) {
  clearInterval(timer);
  timer = null;
  try { connection?.terminate(); } catch { /* already closed */ }
  connection = null;
  $('stop').disabled = true;
  $('status').textContent = message ?? 'Parado.';
}

async function main() {
  describeBrowser();
  showDiag();
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('diag').textContent); $('copy').textContent = 'Copiado!'; } catch { $('copy').textContent = 'Não foi possível copiar'; }
  });
  if (!('PresentationRequest' in window)) {
    $('support').textContent = 'Este navegador não tem a Presentation API. Use o Chrome no Android.';
    return;
  }
  const url = new URL('cast-receiver.html', location.href).href;
  const request = new PresentationRequest([url]);
  $('support').textContent = 'Presentation API disponível. Procurando telas…';
  try {
    const availability = await request.getAvailability();
    const update = () => {
      diag.disponibilidade = availability.value ? 'há tela(s) Cast' : 'nenhuma tela encontrada';
      showDiag();
      $('support').textContent = availability.value
        ? 'Presentation API disponível: há uma tela (Cast) na rede.'
        : 'Presentation API disponível, mas nenhuma tela (Cast) foi encontrada. A TV e o celular precisam estar na mesma rede Wi-Fi.';
      $('cast').disabled = false; // the picker can still find devices on demand
    };
    availability.onchange = update;
    update();
  } catch (e) {
    diag.disponibilidade = `indisponível (${e.name}: ${e.message})`;
    showDiag();
    $('support').textContent = `A busca de telas não está disponível (${e.name}); tente mesmo assim.`;
    $('cast').disabled = false;
  }

  $('cast').addEventListener('click', async () => {
    try {
      $('status').textContent = 'Escolha a TV na lista…';
      attach(await request.start());
    } catch (e) {
      diag.ultimoErro = `${e.name}: ${e.message}`;
      showDiag();
      $('status').textContent = e.name === 'NotAllowedError' ? 'Seleção cancelada.' : `Não foi possível iniciar: ${e.name} ${e.message}`;
    }
  });
  $('stop').addEventListener('click', () => stop());
}

main();
