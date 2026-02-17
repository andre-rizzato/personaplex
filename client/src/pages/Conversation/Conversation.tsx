import { FC, MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSocket } from "./hooks/useSocket";
import { SocketContext } from "./SocketContext";
import { ServerAudio } from "./components/ServerAudio/ServerAudio";
import { UserAudio } from "./components/UserAudio/UserAudio";
import { Button } from "../../components/Button/Button";
import { ServerAudioStats } from "./components/ServerAudio/ServerAudioStats";
import { AudioStats } from "./hooks/useServerAudio";
import { TextDisplay } from "./components/TextDisplay/TextDisplay";
import { MediaContext } from "./MediaContext";
import { ServerInfo } from "./components/ServerInfo/ServerInfo";
import { ModelParamsValues, useModelParams } from "./hooks/useModelParams";
import fixWebmDuration from "webm-duration-fix";
import { getMimeType, getExtension } from "./getMimeType";
import { type ThemeType } from "./hooks/useSystemTheme";
import { WSMessage } from "../../protocol/types";

type ProgressStep = {
  step: string;
  status: "running" | "done" | "started";
  detail: string;
  elapsed: number;
};

const STEP_LABELS: Record<string, string> = {
  init: "Initializing",
  voice_prompt: "Voice Prompt",
  audio_silence_1: "Audio Silence",
  text_prompt: "Text Prompt",
  audio_silence_2: "Audio Silence",
  ready: "Ready",
};

const ProgressPanel: FC<{ steps: ProgressStep[] }> = ({ steps }) => {
  if (steps.length === 0) return null;
  const latest = steps[steps.length - 1];
  const isReady = latest.step === "ready" && latest.status === "done";
  return (
    <div className="w-full max-w-md mx-auto my-4 p-4 rounded-lg bg-base-200 shadow text-sm font-mono">
      <div className="font-bold text-base mb-2">System Prompt Processing</div>
      <div className="space-y-1">
        {steps.map((s, i) => {
          const label = STEP_LABELS[s.step] || s.step;
          const icon = s.status === "done" ? "\u2705" : s.status === "running" ? "\u23F3" : "\u2022";
          return (
            <div key={i} className={`flex items-center gap-2 ${s.status === "running" ? "text-warning" : s.status === "done" ? "text-success" : ""}`}>
              <span>{icon}</span>
              <span className="flex-1">{label}</span>
              <span className="tabular-nums text-xs opacity-70">{s.elapsed.toFixed(1)}s</span>
              {s.status === "done" && s.step !== "init" && s.step !== "ready" && (
                <span className="text-xs opacity-50">({s.detail.match(/\([\d.]+s\)/)?.[0]?.slice(1,-1) || ""})</span>
              )}
            </div>
          );
        })}
      </div>
      {isReady && (
        <div className="mt-2 pt-2 border-t border-base-300 text-success font-bold text-center">
          Ready to talk! ({latest.elapsed.toFixed(1)}s total)
        </div>
      )}
      {!isReady && (
        <div className="mt-2 pt-2 border-t border-base-300 text-warning text-center animate-pulse">
          Processing… {latest.elapsed.toFixed(1)}s elapsed
        </div>
      )}
    </div>
  );
};

type ConversationProps = {
  workerAddr: string;
  workerAuthId?: string;
  sessionAuthId?: string;
  sessionId?: number;
  email?: string;
  theme: ThemeType;
  audioContext: MutableRefObject<AudioContext|null>;
  worklet: MutableRefObject<AudioWorkletNode|null>;
  onConversationEnd?: () => void;
  isBypass?: boolean;
  startConnection: () => Promise<void>;
} & Partial<ModelParamsValues>;


const buildURL = ({
  workerAddr,
  params,
  workerAuthId,
  email,
  textSeed,
  audioSeed,
}: {
  workerAddr: string;
  params: ModelParamsValues;
  workerAuthId?: string;
  email?: string;
  textSeed: number;
  audioSeed: number;
}) => {
  let resolvedAddr = workerAddr;
  if (workerAddr === "same" || workerAddr === "") {
    resolvedAddr = window.location.hostname + ":" + window.location.port;
    console.log("Overriding workerAddr to", resolvedAddr);
  }
  const wsProtocol = (window.location.protocol === 'https:') ? 'wss' : 'ws';
  const url = new URL(`${wsProtocol}://${resolvedAddr}/api/chat`);
  if(workerAuthId) {
    url.searchParams.append("worker_auth_id", workerAuthId);
  }
  if(email) {
    url.searchParams.append("email", email);
  }
  url.searchParams.append("text_temperature", params.textTemperature.toString());
  url.searchParams.append("text_topk", params.textTopk.toString());
  url.searchParams.append("audio_temperature", params.audioTemperature.toString());
  url.searchParams.append("audio_topk", params.audioTopk.toString());
  url.searchParams.append("pad_mult", params.padMult.toString());
  url.searchParams.append("text_seed", textSeed.toString());
  url.searchParams.append("audio_seed", audioSeed.toString());
  url.searchParams.append("repetition_penalty_context", params.repetitionPenaltyContext.toString());
  url.searchParams.append("repetition_penalty", params.repetitionPenalty.toString());
  url.searchParams.append("text_prompt", params.textPrompt.toString());
  url.searchParams.append("voice_prompt", params.voicePrompt.toString());
  console.log(url.toString());
  return url.toString();
};


export const Conversation:FC<ConversationProps> = ({
  workerAddr,
  workerAuthId,
  audioContext,
  worklet,
  sessionAuthId,
  sessionId,
  onConversationEnd,
  startConnection,
  isBypass=false,
  email,
  theme,
  ...params
}) => {
  const getAudioStats = useRef<() => AudioStats>(() => ({
    playedAudioDuration: 0,
    missedAudioDuration: 0,
    totalAudioMessages: 0,
    delay: 0,
    minPlaybackDelay: 0,
    maxPlaybackDelay: 0,
  }));
  const isRecording = useRef<boolean>(false);
  const audioChunks = useRef<Blob[]>([]);

  const audioStreamDestination = useRef<MediaStreamAudioDestinationNode>(audioContext.current!.createMediaStreamDestination());
  const stereoMerger = useRef<ChannelMergerNode>(audioContext.current!.createChannelMerger(2));
  const audioRecorder = useRef<MediaRecorder>(new MediaRecorder(audioStreamDestination.current.stream, { mimeType: getMimeType("audio"), audioBitsPerSecond: 128000  }));
  const [audioURL, setAudioURL] = useState<string>("");
  const [isOver, setIsOver] = useState(false);
  const modelParams = useModelParams(params);
  const micDuration = useRef<number>(0);
  const actualAudioPlayed = useRef<number>(0);
  const textContainerRef = useRef<HTMLDivElement>(null);
  const textSeed = useMemo(() => Math.round(1000000 * Math.random()), []);
  const audioSeed = useMemo(() => Math.round(1000000 * Math.random()), []);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);

  const WSURL = buildURL({
    workerAddr,
    params: modelParams,
    workerAuthId,
    email: email,
    textSeed: textSeed,
    audioSeed: audioSeed,
  });

  const onDisconnect = useCallback(() => {
    setIsOver(true);
    console.log("on disconnect!");
    stopRecording();
  }, [setIsOver]);

  const onSocketMessage = useCallback((message: WSMessage) => {
    if (message.type === "metadata" && message.data && typeof message.data === "object") {
      const data = message.data as Record<string, unknown>;
      if (data.kind === "progress") {
        setProgressSteps(prev => [
          ...prev.filter(s => !(s.step === data.step && s.status !== "done")),
          { step: data.step as string, status: data.status as ProgressStep["status"], detail: data.detail as string, elapsed: data.elapsed as number },
        ]);
      }
    }
  }, []);

  const { socketStatus, sendMessage, socket, start, stop } = useSocket({
    onMessage: onSocketMessage,
    uri: WSURL,
    onDisconnect,
  });
  useEffect(() => {
    audioRecorder.current.ondataavailable = (e) => {
      audioChunks.current.push(e.data);
    };
    audioRecorder.current.onstop = async () => {
      let blob: Blob;
      const mimeType = getMimeType("audio");
      if(mimeType.includes("webm")) {
        blob = await fixWebmDuration(new Blob(audioChunks.current, { type: mimeType }));
        } else {
          blob = new Blob(audioChunks.current, { type: mimeType });
      }
      setAudioURL(URL.createObjectURL(blob));
      audioChunks.current = [];
      console.log("Audio Recording and encoding finished");
    };
  }, [audioRecorder, setAudioURL, audioChunks]);


  useEffect(() => {
    start();
    return () => {
      stop();
    };
  }, [start, workerAuthId]);

  const startRecording = useCallback(() => {
    if(isRecording.current) {
      return;
    }
    console.log(Date.now() % 1000, "Starting recording");
    console.log("Starting recording");
    // Build stereo routing for recording: left = server (worklet), right = user mic (connected in useUserAudio)
    try {
      stereoMerger.current.disconnect();
    } catch {}
    try {
      worklet.current?.disconnect(audioStreamDestination.current);
    } catch {}
    // Route server audio (mono) to left channel of merger
    worklet.current?.connect(stereoMerger.current, 0, 0);
    // Connect merger to the MediaStream destination
    stereoMerger.current.connect(audioStreamDestination.current);

    setAudioURL("");
    audioRecorder.current.start();
    isRecording.current = true;
  }, [isRecording, worklet, audioStreamDestination, audioRecorder, stereoMerger]);

  const stopRecording = useCallback(() => {
    console.log("Stopping recording");
    console.log("isRecording", isRecording)
    if(!isRecording.current) {
      return;
    }
    try {
      worklet.current?.disconnect(stereoMerger.current);
    } catch {}
    try {
      stereoMerger.current.disconnect(audioStreamDestination.current);
    } catch {}
    audioRecorder.current.stop();
    isRecording.current = false;
  }, [isRecording, worklet, audioStreamDestination, audioRecorder, stereoMerger]);

  const onPressConnect = useCallback(async () => {
      if (isOver) {
        window.location.reload();
      } else {
        audioContext.current?.resume();
        if (socketStatus !== "connected") {
          setProgressSteps([]);
          start();
        } else {
          stop();
        }
      }
    }, [socketStatus, isOver, start, stop]);

  const socketColor = useMemo(() => {
    if (socketStatus === "connected") {
      return 'bg-[#76b900]';
    } else if (socketStatus === "connecting") {
      return 'bg-orange-300';
    } else {
      return 'bg-red-400';
    }
  }, [socketStatus]);

  const socketButtonMsg = useMemo(() => {
    if (isOver) {
      return 'New Conversation';
    }
    if (socketStatus === "connected") {
      return 'Disconnect';
    } else {
      return 'Connecting...';
    }
  }, [isOver, socketStatus]);

  return (
    <SocketContext.Provider
      value={{
        socketStatus,
        sendMessage,
        socket,
      }}
    >
    <div>
    <div className="main-grid h-screen max-h-screen w-screen p-4 max-w-96 md:max-w-screen-lg m-auto">
      <div className="controls text-center flex justify-center items-center gap-2">
         <Button
            onClick={onPressConnect}
            disabled={socketStatus !== "connected" && !isOver}
          >
            {socketButtonMsg}
          </Button>
          <div className={`h-4 w-4 rounded-full ${socketColor}`} />
        </div>
        {socketStatus === "connected" && progressSteps.length > 0 && (
          <ProgressPanel steps={progressSteps} />
        )}
        {audioContext.current && worklet.current && <MediaContext.Provider value={
          {
            startRecording,
            stopRecording,
            audioContext: audioContext as MutableRefObject<AudioContext>,
            worklet: worklet as MutableRefObject<AudioWorkletNode>,
            audioStreamDestination,
            stereoMerger,
            micDuration,
            actualAudioPlayed,
          }
        }>
          <div className="relative player h-full max-h-full w-full justify-between gap-3 md:p-12">
              <ServerAudio
                setGetAudioStats={(callback: () => AudioStats) =>
                  (getAudioStats.current = callback)
                }
                theme={theme}
              />
              <UserAudio theme={theme}/>
              <div className="pt-8 text-sm flex justify-center items-center flex-col download-links">
                {audioURL && <div><a href={audioURL} download={`personaplex_audio.${getExtension("audio")}`} className="pt-2 text-center block">Download audio</a></div>}
              </div>
          </div>
          <div className="scrollbar player-text" ref={textContainerRef}>
            <TextDisplay containerRef={textContainerRef}/>
          </div>
          <div className="player-stats hidden md:block">
            <ServerAudioStats getAudioStats={getAudioStats} />
          </div></MediaContext.Provider>}
        </div>
        <div className="max-w-96 md:max-w-screen-lg p-4 m-auto text-center">
          <ServerInfo/>
        </div>
      </div>
    </SocketContext.Provider>
  );
};

        // </MediaContext.Provider> : undefined}
        // 
        // }></MediaContext.Provider>
