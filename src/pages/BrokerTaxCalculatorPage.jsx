import PublicToolShell from '@/components/public/PublicToolShell';
import DegiroCsvCalculator from '@/components/public/DegiroCsvCalculator';

// /calculadora-renta-broker: plusvalías para la Renta desde el CSV de DEGIRO,
// calculadas en el navegador. NO se enlaza desde la app (taxReportService
// pendiente de arreglo): solo desde las páginas públicas (PUBLIC_TOOLS).
const BrokerTaxCalculatorPage = () => (
  <PublicToolShell ns="renta_calc" path="/calculadora-renta-broker">
    <DegiroCsvCalculator />
  </PublicToolShell>
);

export default BrokerTaxCalculatorPage;
