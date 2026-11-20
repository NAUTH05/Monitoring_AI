'use client';

import { connectSocket, getSocket } from '@/lib/socket';
import { Alert, CameraStatus, Event } from '@/types';
import { useEffect } from 'react';

type AlertCallback = (alert: Alert & { event: Event }) => void;
type EventCallback = (event: Event) => void;
type CameraStatusCallback = (payload: { id: string; status: CameraStatus; lastHeartbeat?: string }) => void;
type CameraActivationCallback = (payload: { id: string; isActive: boolean; updatedAt?: string }) => void;

export function useSocket(
  onNewAlert?: AlertCallback,
  onNewEvent?: EventCallback,
  onCameraStatus?: CameraStatusCallback,
  onCameraActivation?: CameraActivationCallback,
) {
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;

    connectSocket();
    const socket = getSocket();

    if (onNewAlert) socket.on('new-alert', onNewAlert);
    if (onNewEvent) socket.on('new-event', onNewEvent);
    if (onCameraStatus) socket.on('camera-status', onCameraStatus);
    if (onCameraActivation) socket.on('camera-activation', onCameraActivation);

    return () => {
      if (onNewAlert) socket.off('new-alert', onNewAlert);
      if (onNewEvent) socket.off('new-event', onNewEvent);
      if (onCameraStatus) socket.off('camera-status', onCameraStatus);
      if (onCameraActivation) socket.off('camera-activation', onCameraActivation);
    };
  }, [onNewAlert, onNewEvent, onCameraStatus, onCameraActivation]);
}
