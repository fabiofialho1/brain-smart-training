# Brain Smart Training (Muse 2 EEG PWA)

App web de uso pessoal que conecta ao headband **Muse 2** por Web Bluetooth
(serviço BLE `0xfe8d`) no Chrome do Android.

## O que faz

- Conecta/desconecta e reconecta sozinho se o sinal cair
- EEG dos 4 canais (TP9, AF7, AF8, TP10) a 256 Hz, PPG infravermelho (64 Hz), acelerômetro (52 Hz) e bateria
- Gráfico em tempo real do sinal bruto (escala e janela ajustáveis; filtro 1–40 Hz opcional) e indicador de qualidade por canal (ruído de banda larga em 55–100 Hz, que denuncia eletrodo mal encostado)
- As barras de bandas só usam canais com bom contato; a tabela mostra dB de µV²/Hz (mesma escala do app oficial da Muse) e deixa os canais excluídos esmaecidos
- Gráfico das bandas ao longo do tempo (dB de µV²/Hz, um ponto a cada 4 s, janela de 1, 5 ou 10 min), com botões para ver todas ou uma só, como o app oficial
- Potência das bandas delta (1–4 Hz), theta (4–8), alfa (7,5–13), beta (13–30) e gama (30–44) por FFT numa janela de 2 s
- Frequência cardíaca estimada pelo espectro do PPG (janela de 10 s; só mostra o valor com sinal bom)
- Indicador "Coração" ao lado dos canais de EEG: aguardando, medindo, bom ou sinal fraco (só avisa depois de 3 leituras fracas seguidas)
- Gravação de sessão e exportação em CSV
- **Jogo do foguete** (relaxamento, não é tratamento): confere os sensores antes; se todos estiverem bons usa todos, senão sugere ignorar os ruins (e deixa usar todos mesmo assim). Calibra 1 min na linha de base da própria pessoa; o foguete sobe enquanto ela fica calma. Com um sensor bom atrás das orelhas mede ondas alfa; só com a testa mede relaxamento do rosto e do corpo (pouca tensão muscular e pouco movimento da cabeça). Pausa quando o sinal piora ou há muito movimento. Resumo no fim. Para testar rápido: `?calib=10&play=20` no endereço encurta as fases.

O protocolo foi implementado do zero com base no muse-js (sem dependências, sem build). A partida da transmissão segue o que o app oficial faz, observado numa captura Bluetooth do próprio aparelho (firmware 1.0.22): `v7`, `s`, `h`, preset `p51` (ou `p21` sem PPG), `s`, assinaturas e `dc001`, com `d` como plano B se o EEG não chegar em 3 s. Como o app oficial, não assina o giroscópio nem os PPG ambiente e vermelho.

## Como usar

1. Ligue o Muse 2 (LED piscando) e abra o app no Chrome do Android.
2. Toque em **Conectar ao Muse 2** e escolha o aparelho. O Bluetooth (e, em Android < 12, a localização) precisa estar ligado.
3. Para instalar: menu do Chrome › *Instalar app*.
4. **Gravar** / **Parar gravação** e depois baixe os CSVs. Mantenha a tela ligada.

## CSV

Um arquivo por tipo, tempo em segundos desde o início da gravação. Pacotes perdidos viram células vazias.

| Arquivo | Colunas |
|---|---|
| `eeg` | `time_s, TP9, AF7, AF8, TP10` (µV) |
| `ppg` | `time_s, ambient, infrared, red` (contagens brutas; só `infrared` é preenchido) |
| `movimento` | `time_s, acc_x_g, acc_y_g, acc_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps` (giroscópio vazio) |
| `bandas` | `time_s`, potência (µV²) de cada banda por canal (`TP9_delta_uv2`, …) e `hr_bpm` |

## Rodar e publicar

- Local: `npm start` e abrir http://localhost:8000 (localhost conta como contexto seguro). No celular é preciso HTTPS.
- Publicação: push em `main` aciona `.github/workflows/pages.yml` (GitHub Pages).
  Antes, ative em *Settings › Pages › Source: GitHub Actions*. Atenção: Pages em repositório
  privado exige plano pago e o site fica público.
- Testes: `npm test`.

## Limitações

- Testado com um Muse 2 simulado e testes unitários; os limiares de qualidade do EEG e da FC (`dsp.js`) podem precisar de ajuste com o aparelho real.
- A FC é estimada pelo pico espectral; com movimento ou mau contato pode falhar (mostra `--`).
- Em segundo plano o Chrome pode pausar a coleta; use a tela ligada.
