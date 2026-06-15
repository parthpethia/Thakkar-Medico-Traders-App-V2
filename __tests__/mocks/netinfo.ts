// Manual mock for @react-native-community/netinfo
const NetInfo = {
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
  configure: jest.fn(),
  refresh: jest.fn().mockResolvedValue({ isConnected: true, isInternetReachable: true }),
};

export default NetInfo;
export const addEventListener = NetInfo.addEventListener;
export const fetch = NetInfo.fetch;
export const configure = NetInfo.configure;
