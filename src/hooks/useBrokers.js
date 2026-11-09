import { useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/customSupabaseClient';

async function fetchBrokers(userId) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('brokers')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

/**
 * Shared hook for loading the broker list of the authenticated user.
 * Uses React Query for caching and background refetch.
 *
 * Returns:
 *   brokers       - array of broker objects
 *   brokersRef    - ref that always holds the latest value (safe for async closures)
 *   brokersLoading
 *   loadBrokers   - force-refetch (returns fresh list)
 */
export function useBrokers(userId) {
  const queryClient = useQueryClient();
  const brokersRef = useRef([]);

  const { data: brokers = [], isLoading: brokersLoading } = useQuery({
    queryKey: ['brokers', userId],
    queryFn: () => fetchBrokers(userId),
    enabled: !!userId,
    staleTime: 30_000,
  });

  // Keep ref in sync for async closures that need latest brokers without re-render
  useEffect(() => {
    brokersRef.current = brokers;
  }, [brokers]);

  const loadBrokers = async () => {
    const fresh = await queryClient.fetchQuery({
      queryKey: ['brokers', userId],
      queryFn: () => fetchBrokers(userId),
      staleTime: 0,
    });
    brokersRef.current = fresh;
    return fresh;
  };

  return { brokers, brokersRef, brokersLoading, loadBrokers };
}
