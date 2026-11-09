import PublicToolShell from '@/components/public/PublicToolShell';
import FireCalculator from '@/components/public/FireCalculator';

const FireCalculatorPage = () => (
  <PublicToolShell ns="fire_calc" path="/calculadora-fire">
    <FireCalculator />
  </PublicToolShell>
);

export default FireCalculatorPage;
