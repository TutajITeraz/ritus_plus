import { useEffect, useState } from "react";
import { Text } from "@chakra-ui/react";
import { fetchTranscribeDeviceStatus } from "../apiUtils";

/**
 * Small status line reporting whether the server transcribes on GPU or CPU.
 * Fetched once (the device is fixed for the server process's lifetime) and
 * shared by every "transcription window" that wants to show it.
 */
const DeviceStatusBadge = ({ fontSize = "xs" }) => {
  const [status, setStatus] = useState(null); // {device, is_gpu, gpu_name} | "error" | null (loading)

  useEffect(() => {
    let cancelled = false;
    fetchTranscribeDeviceStatus()
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatus("error"); });
    return () => { cancelled = true; };
  }, []);

  if (!status || status === "error") return null;

  return (
    <Text fontSize={fontSize} color={status.is_gpu ? "green.600" : "orange.600"}>
      {status.is_gpu
        ? `⚡ Running on GPU${status.gpu_name ? ` (${status.gpu_name})` : ""}`
        : "🐢 Running on CPU (no GPU detected — transcription will be slow)"}
    </Text>
  );
};

export default DeviceStatusBadge;
