# Banco Digital: jornada de estudo do Pix

Um web app que simula dois bancos digitais (Banco Alfa e Banco Beta) falando
com um "Bacen" simulado, pelos mesmos caminhos de um PSP real:

```
 navegador            banco digital (PSP)                 "Bacen" simulado
┌──────────┐  JSON  ┌───────────────────────┐  mTLS  ┌──────────────────────────┐
│ app do   │ ─────► │ clientes e contas      │ ─────► │ DICT  /api/v2/entries    │
│ cliente  │        │ diario de bordo (SSE)  │        │ ICOM  /api/v1/in|out     │
│          │ ◄───── │ leitor do stream ICOM  │ ◄───── │ SPI   liquida nas contas │
└──────────┘        └───────────────────────┘        │       PI, AB03 em 40 s   │
                                                      └──────────────────────────┘
```

Cada passo aparece no console e na pagina, com uma frase curta explicando
o porque.

## Como rodar

Precisa de Node 18+, `openssl` e `xmllint` (pacote `libxml2`).

```bash
npm install
npm run demo
```

Abra:

| | URL | Clientes |
|---|---|---|
| Banco Alfa (ISPB 10000001) | http://localhost:3001 | Ana Silva, Bruno Costa |
| Banco Beta (ISPB 20000002) | http://localhost:3002 | Maria Souza, Padaria Pao Quente |
| API de controle do Bacen | http://localhost:18080/participants | contas PI, transacoes, eventos |

Os certificados de teste (CA, servidor e um por banco, com CN = ISPB) sao
gerados em `simulator/certs/` na primeira execucao.

## Roteiro sugerido

1. **Pix por chave.** No Alfa, como Ana, pague `maria@beta.com.br`. Siga o
   diario: EndToEndId, consulta ao DICT com `PI-PayerId`, confirmacao,
   pacs.008 validada no XSD, `POST` no ICOM (201), pacs.002 `ACSC`. No
   Beta aparecem a pacs.008 recebida, o `ACSP` e o credito so depois do
   `ACCC`.
2. **Transferencia interna.** Como Ana, pague `+5511988887777` (Bruno, do
   mesmo banco). Nada sai para o Bacen: o DICT recusaria a consulta e o SPI
   rejeitaria com `AG12`.
3. **Chave inexistente.** Pague `naoexiste@x.com`: o DICT responde 404 e
   cobra 20 fichas do balde do pagador. Repita 5 vezes e veja o 429
   (antiscan).
4. **QR Code.** No Beta, aba *Receber*, gere um QR com valor e txid. Cole o
   payload no Alfa, aba *Pagar QR Code*. A pacs.008 sai com `QRES` e `TxId`.
5. **Rejeicoes do SPI.** Aba *Por agencia e conta*: ISPB `30000003` da
   `RC10`; uma conta que nao existe no Beta da `AC03` (rejeitada pelo banco
   recebedor). O valor volta para o cliente.
6. **Devolucao.** No Beta, no extrato da Maria, clique em *devolver*: sai
   uma pacs.004 (`MD06`) com RtrId `D...`, e o Alfa aceita e credita Ana.
7. **Timeout AB03.** No card *Laboratorio* do Beta, marque *Banco fora do
   ar* e pague a Maria pelo Alfa. O Beta nao responde, e 40 s depois do
   aceite o SPI rejeita com `AB03`: Ana recebe o estorno. Desmarque e veja
   o `RJCT AB03` chegar ao Beta. *Envio bloqueado no SPI* mostra o `DS02`.
8. **Banco Virtual.** `curl -X POST localhost:18080/virtual/pix -d '{"to":"20000002","amount":5,"creditor":{"document":"98765432100","branch":"7","accountNumber":"20001"}}'`
   faz o 99999A03 (participante virtual do Roteiro) pagar a Maria.

## O que olhar no diario

| Passo | O que acontece de verdade |
|---|---|
| EndToEndId | `E` + ISPB + `yyyyMMddHHmm` em UTC + 11 caracteres |
| DICT GET | `GET /api/v2/entries/{chave}` com `PI-RequestingParticipant`, `PI-PayerId` e `PI-EndToEndId`; antiscan por pagador e por banco |
| pacs.008 | `AppHdr/To` e sempre o SPI (`00038166`); o outro banco so aparece em `CdtrAgt` |
| ICOM POST | `POST /api/v1/in/{ispb}/msgs`, 201 com `PI-ResourceId`; a validacao vem depois |
| stream | `GET /api/v1/out/{ispb}/stream/start` e cada `PI-Pull-Next` (long polling) |
| pacs.002 | recebedor responde `ACSP`/`RJCT`; o SPI liquida e avisa `ACSC` (pagador) e `ACCC` (recebedor) |
| prazo | 40 s desde o `AccptncDtTm`; sem resposta, `AB03` |

## Arquivos

- `src/bank.ts`: o banco (clientes, DICT, ICOM, respostas ao SPI)
- `src/journey.ts`: o diario de bordo (console colorido + SSE)
- `src/web.ts`: API JSON e arquivos estaticos
- `src/demo.ts`: sobe o Bacen simulado e os dois bancos
- `public/`: a pagina (HTML, CSS e JS sem build)
- `test/bank-journey.test.ts`: as jornadas acima, automatizadas

O simulador nao assina as mensagens (XMLDSig): o elemento `Sgntr` vai
vazio. Fora isso, o formato das mensagens segue o catalogo 5.13 do SPI e a
API DICT 2.12.1.
