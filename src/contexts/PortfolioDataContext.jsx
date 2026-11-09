import { createContext, useContext, useState } from 'react';

/**
 * Shares the Dashboard's already-computed portfolio snapshot with any
 * component in the tree (e.g. PortfolioChatWidget) without re-fetching.
 *
 * The Dashboard calls setPortfolioSnapshot whenever its data refreshes.
 * Consumers (e.g. chat widget) read it directly — no independent fetch needed.
 */
const PortfolioDataContext = createContext(null);

export function PortfolioDataProvider({ children }) {
  const [portfolioSnapshot, setPortfolioSnapshot] = useState(null);
  return (
    <PortfolioDataContext.Provider value={{ portfolioSnapshot, setPortfolioSnapshot }}>
      {children}
    </PortfolioDataContext.Provider>
  );
}

export function usePortfolioData() {
  return useContext(PortfolioDataContext);
}
