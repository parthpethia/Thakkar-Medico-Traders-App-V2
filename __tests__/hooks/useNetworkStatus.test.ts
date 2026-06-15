import { renderHook, act } from '@testing-library/react-native';
import NetInfo from '@react-native-community/netinfo';
import { useNetworkStatus } from '../../src/hooks/useNetworkStatus';

// The module is mapped via moduleNameMapper to __tests__/mocks/netinfo.ts

describe('useNetworkStatus', () => {
  const mockAddEventListener = NetInfo.addEventListener as jest.Mock;
  let unsubscribeMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    unsubscribeMock = jest.fn();
    mockAddEventListener.mockReturnValue(unsubscribeMock);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts as online by default', () => {
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(true);
  });

  it('subscribes to NetInfo on mount', () => {
    renderHook(() => useNetworkStatus());
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = renderHook(() => useNetworkStatus());
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('updates isOnline when network state changes (after debounce)', () => {
    const { result } = renderHook(() => useNetworkStatus());

    const callback = mockAddEventListener.mock.calls[0][0];

    // Simulate going offline
    act(() => {
      callback({ isConnected: false, isInternetReachable: false });
      jest.advanceTimersByTime(1100); // debounce is 1000ms
    });

    expect(result.current.isOnline).toBe(false);

    // Simulate going back online
    act(() => {
      callback({ isConnected: true, isInternetReachable: true });
      jest.advanceTimersByTime(1100);
    });

    expect(result.current.isOnline).toBe(true);
  });
});
