# Email Template: Scheduling the SPI Capacity Test with Bacen

The Roteiro para Participação Direta no SPI only defines a scheduling email for the **capacity test** (Anexo II). It is sent to **spi@bcb.gov.br**, from the institution's SPI email address informed in the "Formulário de adesão ao Pix", to book a **one-hour window** in which both the payer and the receiver tests run simultaneously. The other SPI functional tests are run by the participant without scheduling.

---

**To:** spi@bcb.gov.br
**From:** [SPI email address informed in the Formulário de adesão ao Pix]
**Subject:** Solicitação de agendamento de teste de capacidade referente ao processo homologatório no SPI

---

Solicitamos o agendamento de teste de capacidade referente ao processo homologatório no SPI:

- Nome e ISPB do participante: [PSP Legal Name] – [ISPB, 8 characters [0-9A-Z]]
- Data (dia útil): [date]
- Hora de início (9h, 10h, 13h, 14h, 20h, 21h ou 22h): [hour]
- Nome e telefone(s) de contato do responsável pela condução dos testes: [name] – [phone(s)]

Atenciosamente,

[Responsável pela condução dos testes]

---

## Notes for using this template

1. **Official model**: the body above is the Roteiro's Anexo II. Keep it short; extra technical details are optional.
2. **Window**: one hour, starting at 9h, 10h, 13h, 14h, 20h, 21h or 22h on a business day. If the window is taken, Deban/Gemon contacts you to agree on another one.
3. **Volume**: by number of transactional accounts, sent and received over 10 minutes: 10,000 (up to 1M accounts, 1,000/min), 20,000 (up to 10M, 2,000/min) or 40,000 (above 10M, 4,000/min). Liquidante especial participants use the 40,000 tier; instituição usuária participants use the 10,000 tier.
4. **Payer test**: pacs.008 with priority HIGH to 99999A04 (Cooperativa de Crédito Virtual), which answers ACSP. Consume at least 99% of the SPI's pacs.002 within 200 ms.
5. **Receiver test**: Bacen sends pacs.008 HIGH from 99999A03 (Banco Virtual). Accept all of them; consume at least 99% within 200 ms; at least 50% of payments within 1.4s and 95% within 2.3s.
6. **During the test**: Deban/Gemon calls the phone number you provided and informs the result right after. If it fails, you can repeat it if there is time left, or book a new window.
7. **Results summary**: during the tests you can ask for the "Resumo dos Resultados dos Testes Homologatórios no SPI" at spi@bcb.gov.br.
8. **DICT tests**: scheduling of DICT tests is not covered by the Roteiro; follow the instructions Bacen gives you for the DICT (practical experience).
9. **Timing** (practical experience): send the request at least 2 weeks in advance.

Source: [Roteiro para Participação Direta no SPI e abertura de Conta PI](https://www.bcb.gov.br/content/estabilidadefinanceira/sistemapagamentosinstantaneos_docs/Roteiro_para_Participacao_Direta_no_SPI_e_abertura_de_Conta_PI.pdf), item 7 and Anexo II.
