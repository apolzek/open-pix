# Especificações oficiais

Cópias dos artefatos publicados pelo Banco Central, usadas pelos testes para
validar as mensagens geradas pelo toolkit e pelo simulador contra a fonte real.

| Pasta | Origem | Versão |
|---|---|---|
| `spi-5.13.1/xsd` | Catálogo de Mensagens e Serviços do SPI, pacote `spi.5.13.1.zip` em https://www.bcb.gov.br/content/estabilidadefinanceira/cedsfn/Catalogos/spi.5.13.1.zip | 5.13.1 (pacs.008 1.16, pacs.002 1.17, pacs.004 1.5) |
| `spi-5.13.1/exemplos` | Exemplos do mesmo pacote | 5.13.1 |
| `dict-2.12.1/openapi.json` | Especificação OpenAPI embutida em https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html (licença Apache 2.0, conforme o Manual das Interfaces de Comunicação) | 2.12.1 |

Os exemplos oficiais trazem `<Sgntr/>` vazio. O XSD exige ali uma assinatura
XMLDSig, então a validação dos testes aceita esse único erro enquanto a
mensagem não é assinada.

Ao atualizar o catálogo, troque os arquivos e ajuste
`config.spiMessageVersions` e `scripts/spi/spi-envelope.ts`.
