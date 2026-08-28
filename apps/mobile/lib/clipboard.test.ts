import { beforeEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("expo-clipboard", () => ({
  setStringAsync: jest.fn(),
}));

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import * as Clipboard from "expo-clipboard";
import { copyToClipboard } from "./clipboard";

const mockSetStringAsync = jest.mocked(Clipboard.setStringAsync);

describe("copyToClipboard on native", () => {
  beforeEach(() => {
    mockSetStringAsync.mockReset();
  });

  test("copies through Expo and reports success", async () => {
    mockSetStringAsync.mockResolvedValue(undefined);

    await expect(copyToClipboard("#891d1a")).resolves.toBe(true);
    expect(mockSetStringAsync).toHaveBeenCalledWith("#891d1a");
  });

  test("reports failure when the native clipboard rejects", async () => {
    mockSetStringAsync.mockRejectedValue(new Error("clipboard unavailable"));

    await expect(copyToClipboard("text")).resolves.toBe(false);
  });
});
