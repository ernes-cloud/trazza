import PublicToolShell from '@/components/public/PublicToolShell';
import DividendCalculator from '@/components/public/DividendCalculator';

const DividendCalculatorPage = () => (
  <PublicToolShell ns="div_calc" path="/calculadora-dividendos">
    <DividendCalculator />
  </PublicToolShell>
);

export default DividendCalculatorPage;
