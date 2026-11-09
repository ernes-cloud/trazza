import { Navigate } from 'react-router-dom';
import { useSupabaseAuth } from '@/contexts/SupabaseAuthContext';
import CompoundInterestCalculator from '@/components/CompoundInterestCalculator';
import PublicToolShell from '@/components/public/PublicToolShell';

/* La estructura de la página (cabecera, titular, explicación, llamada al
   registro, otras calculadoras y pie) es común a todas las herramientas
   públicas: vive en PublicToolShell. El canonical lo pone SeoHead con la URL
   de example.com (antes apuntaba a https://trazza.app/…, otra web). */
const CompoundInterestPage = () => {
  const { user } = useSupabaseAuth();

  // Quien tiene sesión usa la calculadora de la app, que parte de su cartera real.
  if (user) return <Navigate to="/app" replace />;

  return (
    <PublicToolShell ns="calc_page" path="/calculadora-interes-compuesto">
      <CompoundInterestCalculator />
    </PublicToolShell>
  );
};

export default CompoundInterestPage;
