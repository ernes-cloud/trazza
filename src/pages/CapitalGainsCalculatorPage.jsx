import PublicToolShell from '@/components/public/PublicToolShell';
import CapitalGainsCalculator from '@/components/public/CapitalGainsCalculator';

const CapitalGainsCalculatorPage = () => (
  <PublicToolShell ns="cg_calc" path="/calculadora-plusvalias">
    <CapitalGainsCalculator />
  </PublicToolShell>
);

export default CapitalGainsCalculatorPage;
