import { describe, it, expect } from 'vitest';
import { detectBrokerCsv, detectOtherBroker } from './brokerDetect';

// Cabecera + filas reales de un Account.csv de DeGiro (ES) — el caso reportado:
// pegado en el import de IA producía un resultado "completamente diferente"
// al del importador nativo. Debe detectarse y enrutarse, no ir al LLM.
const DEGIRO_SAMPLE = [
  'Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden',
  '20-06-2026,16:30,20-06-2026,ETC GROUP PHYSICAL BITCOIN,DE000A27Z304,Costes de transacción y/o externos de DEGIRO,,EUR,"-4,00",EUR,"1.245,34",a1-1',
  '20-06-2026,16:30,20-06-2026,ETC GROUP PHYSICAL BITCOIN,DE000A27Z304,"Compra 10 ETC Group Physical Bitcoin@82,50 EUR (DE000A27Z304)",,EUR,"-825,00",EUR,"1.249,34",a1-1',
  '15-06-2026,17:44,15-06-2026,APPLE INC,US0378331005,"Compra 5 Apple Inc@198,50 USD (US0378331005)",,USD,"-992,50",USD,"-992,50",b2-2',
].join('\n');

const MYINVESTOR_SAMPLE = [
  'Fecha de la orden;ISIN;Importe estimado;Nº de participaciones;Estado',
  '10/01/2026;IE00B4L5Y983;500 EUR;5,25;Finalizada',
].join('\n');

describe('detectBrokerCsv', () => {
  it('detecta un Account.csv de DeGiro pegado como texto', () => {
    const det = detectBrokerCsv(DEGIRO_SAMPLE);
    expect(det?.broker).toBe('degiro');
    expect(det?.realTxCount).toBeGreaterThanOrEqual(2);
  });

  it('detecta el CSV de Operaciones de MyInvestor', () => {
    expect(detectBrokerCsv(MYINVESTOR_SAMPLE)?.broker).toBe('myinvestor');
  });

  it('texto libre normal → null (sigue al LLM)', () => {
    const freeText = [
      'Hola, estas son mis operaciones del año:',
      'El 12 de mayo compré 10 acciones de Apple a 150 USD',
      'También tengo 5 de Iberdrola desde enero',
    ].join('\n');
    expect(detectBrokerCsv(freeText)).toBeNull();
  });

  it('vacío o solo espacios → null', () => {
    expect(detectBrokerCsv('')).toBeNull();
    expect(detectBrokerCsv('   \n  ')).toBeNull();
  });

  it('el Transactions.csv de DeGiro (archivo equivocado) también se enruta a degiro', () => {
    // El parser lanza err.code='degiro_transactions_file'; el flujo nativo ya
    // sabe explicar qué export hace falta — mejor eso que el LLM.
    const transactionsCsv = [
      'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden',
      '20-06-2026,16:30,APPLE INC,US0378331005,NDQ,XNAS,5,"198,50",USD,"-992,50",USD,"-872,14",EUR,"1,1380","-2,00",EUR,"-874,14",EUR,b2-2',
    ].join('\n');
    const det = detectBrokerCsv(transactionsCsv);
    expect(det?.broker).toBe('degiro');
  });
});

// "Sincronizar" en un broker de MyInvestor con el selector en DeGiro (el valor
// por defecto): el extracto acababa en el lector de DeGiro, "No se encontraron
// transacciones" y la única salida era gastar cuota de IA.
describe('detectOtherBroker', () => {
  it('reconoce un extracto de MyInvestor subido con DeGiro seleccionado', () => {
    expect(detectOtherBroker(MYINVESTOR_SAMPLE, 'degiro')).toBe('myinvestor');
  });

  it('reconoce un Account.csv de DeGiro subido con MyInvestor seleccionado', () => {
    expect(detectOtherBroker(DEGIRO_SAMPLE, 'myinvestor')).toBe('degiro');
  });

  it('no redirige si el archivo ya es del broker elegido', () => {
    expect(detectOtherBroker(DEGIRO_SAMPLE, 'degiro')).toBeNull();
  });

  it('no redirige un archivo que no es de ningún broker conocido', () => {
    expect(detectOtherBroker('fecha;concepto;importe\n01/01/2026;café;-2', 'degiro')).toBeNull();
  });

  it('no redirige el Transactions.csv de DeGiro (sin operaciones que importar)', () => {
    const txFile = 'Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden';
    expect(detectOtherBroker(txFile, 'myinvestor')).toBeNull();
  });
});
