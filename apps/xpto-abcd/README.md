# Pix do Banco XPTO para o Banco ABCD

Uma pagina so com os dois bancos e o Bacen no meio: o XPTO (ISPB 40000004)
paga, o ABCD (ISPB 50000005) recebe, e cada etapa do Pix acende conforme
acontece no simulador.

```bash
npm run xpto-abcd        # http://localhost:3003
```

Usa o simulador que ja estiver no ar (`SIM_CTL_URL`, padrao
`http://localhost:18080`; `SIM_ICOM_URL` e `SIM_DICT_URL` para o resto).
Sem simulador, sobe um proprio. Os dois bancos entram pela API de controle
(`POST /participants`), recebem certificado com CN = ISPB e falam com o
ICOM e o DICT por mTLS, com o mesmo `Bank` do `apps/banco-digital`. Depois
de um `POST /reset` no simulador, eles se cadastram de novo sozinhos.

| Cliente | Banco | Chaves |
|---|---|---|
| Carlos Pereira, Julia Ramos | XPTO | carlos@xpto.com.br, +5531977776666 |
| Lucas Almeida | ABCD | lucas@abcd.com.br, CPF 97141091750 |
| Loja Bom Preco Ltda | ABCD | CNPJ 29519784000140, EVP |

## O que testar

1. **Pix por chave:** escolha uma chave do ABCD e envie. As 7 etapas vao
   do DICT ate o `ACCC`, e as contas PI mudam no meio da pagina.
2. **Chave inexistente:** o DICT responde 404 e cobra fichas do antiscan.
3. **Devolucao:** no extrato do ABCD, *devolver* manda uma pacs.004.
4. **AB03:** marque *ABCD fora do ar* e envie; 40 s depois o SPI rejeita e
   o Carlos recebe o estorno.

## API

```
GET  /api/state                          os dois bancos
GET  /api/stream                         diarios dos bancos + linha do tempo do Bacen (SSE)
POST /api/pix                            {from, key, amount, description?}
POST /api/pix/{e2e}/return               {amount}
POST /api/lab/offline                    {on}
GET  /api/bacen/participants|transactions
```

```bash
curl -X POST localhost:3003/api/pix -H 'Content-Type: application/json' \
  -d '{"from":"xpto-1","key":"lucas@abcd.com.br","amount":"10,00"}'
```
