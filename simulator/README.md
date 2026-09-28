# Simulador do lado Bacen (ICOM, SPI e DICT)

Simula a infraestrutura do Bacen para um PSP testar a integracao sem a RSFN:

| Servico | Porta | Protocolo |
|---|---|---|
| ICOM + SPI | 16522 (mTLS) | Manual das Interfaces de Comunicacao 1.12, catalogo SPI 5.13 |
| DICT | 16523 (mTLS) | API DICT 2.12.1, subconjunto de chaves e politicas |
| Controle | 18080 (HTTP) | JSON, so do simulador |

```bash
npm run sim:certs            # PKI local em simulator/certs (CN do cliente = ISPB)
npm run sim:start
```

Aponte o toolkit para ele: `ICOM_BASE_URL=https://localhost:16522`,
`DICT_BASE_URL=https://localhost:16523`, `MTLS_CERT_PATH=simulator/certs/<ISPB>.pem`,
`MTLS_KEY_PATH=simulator/certs/<ISPB>.key`, `MTLS_CA_PATH=simulator/certs/ca.pem`.

## O que e reproduzido

**ICOM**: `POST /api/v1/in/{ispb}/msgs` (1 mensagem ou multipart ate 10,
gzip, 201 + `PI-ResourceId`); leitura por `/out/{ispb}/stream/start`,
`PI-Pull-Next` e `DELETE`, long polling com 204, ate 10 mensagens por
leitura, reentrega com o mesmo ResourceId quando o PSP nao confirma, limite
de 6 streams (429), balde de trafego (3750 fichas, 750/s, 429 +
Retry-After), cabecalhos permitidos, `Host` sem porta, charset (400/415),
`/catalog`, e o certificado so opera o proprio ISPB (403).

**SPI**: valida cada mensagem no XSD oficial (admi.002 quando falha, com o
ResourceId), confere `AppHdr` e idempotencia por `BizMsgIdr`, aplica as
rejeicoes que o catalogo atribui ao SPI (`AM18`, `DS02`, `RC09`, `AGNT`,
`RC10`, `AG12`, `AM01`, `FF08`, `AB03`, `AM04`, `CH16`, `DT05`),
encaminha pacs.008/pacs.004 ao recebedor com cabecalho do SPI, liquida nas
contas PI ao receber `ACSP` e avisa `ACSC`/`ACCC`, e rejeita com `AB03` se
o recebedor nao responde em 40 s desde o `AccptncDtTm`.

**Participantes virtuais do Roteiro**: `99999A04` responde `ACSP` a tudo;
`99999A03` envia Pix com os dados do Roteiro (`POST /virtual/pix`).

**DICT**: `POST /entries/`, `GET /entries/{Key}`, `POST /entries/{Key}/delete`,
`GET /policies/{policy}`, com conflitos de chave, EVP gerada, `RequestId`
idempotente, consulta de chave do proprio PSP recusada e antiscan (PF 100
fichas +2/min, 404 custa 20; participante por categoria A..H; fichas
devolvidas quando o Pix liquida).

## O que ainda nao e reproduzido

- Assinatura XMLDSig (`core/signature.ts` esta vazio; `SIM_VERIFY_SIGNATURE`
  so recusa assinatura vazia no DICT).
- Canal secundario, Pix agendado, participantes indiretos e liquidantes.
- Mensagens alem de pacs.008/002/004 e admi.002 (camt, pibr, reda...).
- DICT: reivindicacoes, notificacoes de infracao, devolucoes (MED),
  marcadores de fraude, CIDs e sincronizacao.

## Controle

```
GET  /participants                    saldos das contas PI, fila e streams
POST /participants                    {ispb, name, balance}
POST /participants/{ispb}/block       envio bloqueado (DS02)
GET  /transactions[?id=]              liquidacoes
GET  /dict/entries                    chaves
GET  /events | /events/stream         linha do tempo (JSON | SSE)
POST /virtual/pix                     {to, amount, key?, creditor?}
POST /reset
```

Variaveis de ambiente em `src/config.ts` (`SIM_*`).
