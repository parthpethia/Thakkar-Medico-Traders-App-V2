// PA: H1 — Re-subscribe Realtime when network comes back online
import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '../services/supabase';
import { useNetworkStatus } from './useNetworkStatus';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';

type PostgresChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';

interface UseRealtimeOrdersOptions {
  table: string;
  event?: PostgresChangeEvent | '*';
  filter?: string;
  onInsert?: (payload: RealtimePostgresChangesPayload<any>) => void;
  onUpdate?: (payload: RealtimePostgresChangesPayload<any>) => void;
  onDelete?: (payload: RealtimePostgresChangesPayload<any>) => void;
  enabled?: boolean;
}

interface UseRealtimeOrdersReturn {
  isConnected: boolean;
}

export function useRealtimeOrders({
  table,
  event = '*',
  filter,
  onInsert,
  onUpdate,
  onDelete,
  enabled = true,
}: UseRealtimeOrdersOptions): UseRealtimeOrdersReturn {
  const [isConnected, setIsConnected] = useState(false);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const channelsRef = useRef<RealtimeChannel[]>([]);

  const onInsertRef = useRef(onInsert);
  const onUpdateRef = useRef(onUpdate);
  const onDeleteRef = useRef(onDelete);
  onInsertRef.current = onInsert;
  onUpdateRef.current = onUpdate;
  onDeleteRef.current = onDelete;

  const { isOnline } = useNetworkStatus();
  const wasOnlineRef = useRef(isOnline);

  const removeChannel = useCallback((channel: RealtimeChannel | null) => {
    if (!channel) return;
    supabase.removeChannel(channel);
    channelsRef.current = channelsRef.current.filter((c) => c !== channel);
    if (channelRef.current === channel) {
      channelRef.current = null;
    }
  }, []);

  const subscribe = useCallback(() => {
    if (!enabled) return;

    removeChannel(channelRef.current);
    setIsConnected(false);

    const channelName = `realtime-${table}-${filter || 'all'}-${Date.now()}`;

    const listenConfig: Record<string, string> = {
      event,
      schema: 'public',
      table,
    };

    if (filter) {
      listenConfig.filter = filter;
    }

    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes' as any,
        listenConfig,
        (payload: RealtimePostgresChangesPayload<any>) => {
          if (payload.eventType === 'INSERT' && onInsertRef.current) {
            onInsertRef.current(payload);
          }
          if (payload.eventType === 'UPDATE' && onUpdateRef.current) {
            onUpdateRef.current(payload);
          }
          if (payload.eventType === 'DELETE' && onDeleteRef.current) {
            onDeleteRef.current(payload);
          }
        },
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    channelRef.current = channel;
    channelsRef.current.push(channel);
  }, [table, event, filter, enabled, removeChannel]);

  useEffect(() => {
    if (!enabled) return;
    subscribe();
    return () => {
      for (const ch of [...channelsRef.current]) {
        removeChannel(ch);
      }
      setIsConnected(false);
    };
  }, [enabled, subscribe, removeChannel]);

  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;

    if (!enabled) return;
    if (!wasOnline && isOnline) {
      subscribe();
    }
  }, [isOnline, enabled, subscribe]);

  return { isConnected };
}
