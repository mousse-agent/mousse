import { useCallback, useEffect, useState, useRef } from 'react'
import {
  Smartphone,
  Shield,
  Radio,
  ExternalLink,
  QrCode,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Trash2,
  RefreshCw,
  Clock,
  Key,
  Server,
  Lock,
  Unlock
} from 'lucide-react'
import type {
  ControlMode,
  ControlStatus,
  PairingGrant,
  RemoteScope,
  CreatePairingResult
} from '../../shared/controlTypes'
import { ALL_REMOTE_SCOPES } from '../../shared/controlTypes'
import { generateQrMatrix, qrMatrixToSvg } from '../../shared/qrCode'

interface PendingApprovalData {
  pairingId: string
  mobileDeviceId: string
  mobileDeviceName?: string
  fingerprint: string
  requestedScopes: RemoteScope[]
}

export function ConnectionsSection() {
  const [status, setStatus] = useState<ControlStatus | null>(null)
  const [pairings, setPairings] = useState<PairingGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)

  // Active QR pairing state
  const [activePairing, setActivePairing] = useState<CreatePairingResult | null>(null)
  const [qrSvg, setQrSvg] = useState<string | null>(null)
  const [remainingSecs, setRemainingSecs] = useState<number>(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  // Pending incoming approval
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalData | null>(null)
  const [approvedScopes, setApprovedScopes] = useState<Set<RemoteScope>>(new Set())

  // Self-hosted form inputs
  const [selfHostUrl, setSelfHostUrl] = useState('')
  const [selfHostCode, setSelfHostCode] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [st, pList] = await Promise.all([
        window.mousse.control.getStatus(),
        window.mousse.control.listPairings()
      ])
      setStatus(st)
      setPairings(pList.pairings)

      if (st.pendingPairing && st.pendingPairing.state === 'claimed' && st.pendingPairing.claimedBy) {
        setPendingApproval({
          pairingId: st.pendingPairing.pairingId,
          mobileDeviceId: st.pendingPairing.claimedBy.mobileDeviceId || '',
          mobileDeviceName: st.pendingPairing.claimedBy.mobileDeviceName,
          fingerprint: st.pendingPairing.claimedBy.fingerprint || '',
          requestedScopes: st.pendingPairing.claimedBy.requestedScopes
        })
        setApprovedScopes(new Set(st.pendingPairing.claimedBy.requestedScopes))
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()

    const unsubStatus = window.mousse.control.onStatusChanged((newStatus) => {
      setStatus(newStatus)
      if (newStatus.pendingPairing && newStatus.pendingPairing.state === 'claimed' && newStatus.pendingPairing.claimedBy) {
        setPendingApproval({
          pairingId: newStatus.pendingPairing.pairingId,
          mobileDeviceId: newStatus.pendingPairing.claimedBy.mobileDeviceId || '',
          mobileDeviceName: newStatus.pendingPairing.claimedBy.mobileDeviceName,
          fingerprint: newStatus.pendingPairing.claimedBy.fingerprint || '',
          requestedScopes: newStatus.pendingPairing.claimedBy.requestedScopes
        })
        setApprovedScopes(new Set(newStatus.pendingPairing.claimedBy.requestedScopes))
      }
    })

    const unsubPairing = window.mousse.control.onPairingRequest((req) => {
      setPendingApproval(req)
      setApprovedScopes(new Set(req.requestedScopes))
    })

    return () => {
      unsubStatus()
      unsubPairing()
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [loadData])

  // Countdown timer for active QR
  useEffect(() => {
    if (!activePairing) {
      if (timerRef.current) clearInterval(timerRef.current)
      setQrSvg(null)
      return
    }

    try {
      const matrix = generateQrMatrix(activePairing.qrUri)
      setQrSvg(qrMatrixToSvg(matrix, 4, 5))
    } catch (err) {
      setActionError('Failed to render QR SVG: ' + (err as Error).message)
    }

    const updateTimer = () => {
      const expires = new Date(activePairing.expiresAt).getTime()
      const diff = Math.max(0, Math.floor((expires - Date.now()) / 1000))
      setRemainingSecs(diff)
      if (diff <= 0) {
        setActivePairing(null)
        if (timerRef.current) clearInterval(timerRef.current)
      }
    }

    updateTimer()
    timerRef.current = setInterval(updateTimer, 1000)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [activePairing])

  const handleLogin = async () => {
    setLoggingIn(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      const res = await window.mousse.control.login()
      if (!res.ok) {
        setActionError(res.error || 'Login failed')
      } else {
        setActionSuccess('Signed in successfully!')
        void loadData()
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setLoggingIn(false)
    }
  }

  const handleLogout = async () => {
    setActionError(null)
    try {
      await window.mousse.control.logout()
      setActionSuccess('Logged out successfully')
      void loadData()
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleSelfHostEnroll = async () => {
    if (!selfHostUrl || !selfHostCode) {
      setActionError('Please enter both the server URL and the one-time pairing code')
      return
    }
    setEnrolling(true)
    setActionError(null)
    try {
      const res = await window.mousse.control.enroll(selfHostUrl.trim(), selfHostCode.trim())
      if (!res.ok) {
        setActionError(res.error || 'Enrollment failed')
      } else {
        setActionSuccess('Successfully enrolled with self-hosted control server!')
        setSelfHostCode('')
        void loadData()
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setEnrolling(false)
    }
  }

  const handleDisconnect = async () => {
    setActionError(null)
    try {
      await window.mousse.control.disconnect()
      setActionSuccess('Disconnected from control server')
      void loadData()
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleStartPairing = async () => {
    setActionError(null)
    setActionSuccess(null)
    try {
      const result = await window.mousse.control.createPairing()
      setActivePairing(result)
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleApprove = async () => {
    if (!pendingApproval) return
    setActionError(null)
    try {
      await window.mousse.control.approvePairing(
        pendingApproval.pairingId,
        Array.from(approvedScopes)
      )
      setActionSuccess('Device successfully paired!')
      setPendingApproval(null)
      setActivePairing(null)
      void loadData()
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleReject = async () => {
    if (!pendingApproval) return
    try {
      await window.mousse.control.rejectPairing(pendingApproval.pairingId)
      setPendingApproval(null)
      setActionSuccess('Pairing request rejected')
      void loadData()
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const handleRevoke = async (id: string, deviceName?: string) => {
    if (!confirm(`Are you sure you want to revoke access for ${deviceName || 'this device'}?`)) {
      return
    }
    try {
      await window.mousse.control.revokePairing(id)
      setActionSuccess('Device revoked successfully')
      void loadData()
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const toggleScope = (scope: RemoteScope) => {
    setApprovedScopes((prev) => {
      const next = new Set(prev)
      if (next.has(scope)) {
        next.delete(scope)
      } else {
        next.add(scope)
      }
      return next
    })
  }

  if (loading) {
    return <div className="settings-loading">Loading connection status…</div>
  }

  return (
    <div className="connections-section" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Alerts */}
      {actionError && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(239, 68, 68, 0.15)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: 8,
          color: '#f87171',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}>
          <AlertTriangle size={16} />
          <span>{actionError}</span>
        </div>
      )}

      {actionSuccess && (
        <div style={{
          padding: '10px 14px',
          background: 'rgba(34, 197, 94, 0.15)',
          border: '1px solid rgba(34, 197, 94, 0.3)',
          borderRadius: 8,
          color: '#4ade80',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}>
          <CheckCircle2 size={16} />
          <span>{actionSuccess}</span>
        </div>
      )}

      {/* Control Server Connection Status */}
      <div className="settings-card" style={{
        padding: 20,
        background: 'var(--card-bg, #18181b)',
        borderRadius: 12,
        border: '1px solid var(--border-color, #27272a)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Radio size={18} color={status?.relayConnected ? '#22c55e' : '#94a3b8'} />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
              {status?.mode === 'hosted' ? 'Mousse Plus (Hosted)' : 'Self-Hosted Control Server'}
            </h3>
          </div>
          <span style={{
            fontSize: 12,
            padding: '2px 8px',
            borderRadius: 999,
            fontWeight: 500,
            background: status?.relayConnected ? 'rgba(34, 197, 94, 0.2)' : 'rgba(148, 163, 184, 0.2)',
            color: status?.relayConnected ? '#4ade80' : '#94a3b8'
          }}>
            {status?.relayConnected ? 'Relay Active' : 'Relay Standby'}
          </span>
        </div>

        {/* Hosted mode details */}
        {status?.mode === 'hosted' ? (
          <div>
            <p style={{ fontSize: 13, color: '#a1a1aa', margin: '0 0 16px 0' }}>
              Connect your desktop to Mousse Plus to securely access your local agents, files, and terminals from anywhere via end-to-end encrypted relay.
            </p>

            {status.account ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{
                  padding: 12,
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderRadius: 8,
                  fontSize: 13,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center'
                }}>
                  <div>
                    <div style={{ fontWeight: 500, color: '#f4f4f5' }}>{status.account.email || 'Plus Member'}</div>
                    <div style={{ fontSize: 12, color: '#71717a' }}>Device ID: {status.mmsDeviceId.slice(0, 16)}…</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="settings-btn-secondary"
                      onClick={() => void window.mousse.control.openDashboard()}
                      style={{ padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <ExternalLink size={13} />
                      Dashboard
                    </button>
                    <button
                      type="button"
                      className="settings-btn-secondary"
                      onClick={() => void handleLogout()}
                      style={{ padding: '6px 12px', fontSize: 12 }}
                    >
                      Sign Out
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button
                  type="button"
                  className="settings-btn-primary"
                  onClick={() => void handleLogin()}
                  disabled={loggingIn}
                  style={{
                    padding: '8px 16px',
                    fontSize: 13,
                    fontWeight: 600,
                    background: '#3b82f6',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8
                  }}
                >
                  {loggingIn ? <RefreshCw size={14} className="spin" /> : <Lock size={14} />}
                  Sign In to Mousse Plus
                </button>
                <button
                  type="button"
                  className="settings-btn-secondary"
                  onClick={() => void window.mousse.control.openDashboard()}
                  style={{ padding: '8px 14px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <ExternalLink size={13} />
                  Open Plus Portal
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Self-hosted mode details */
          <div>
            <p style={{ fontSize: 13, color: '#a1a1aa', margin: '0 0 16px 0' }}>
              Connect this MMS instance to a self-hosted Mousse Control Server using an operator-generated enrollment code.
            </p>

            {status?.enrolled ? (
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 12,
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: 8
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#f4f4f5' }}>Enrolled with {status.serverUrl}</div>
                  <div style={{ fontSize: 12, color: '#71717a' }}>Device ID: {status.mmsDeviceId.slice(0, 16)}…</div>
                </div>
                <button
                  type="button"
                  className="settings-btn-secondary"
                  onClick={() => void handleDisconnect()}
                  style={{ padding: '6px 12px', fontSize: 12, color: '#f87171' }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>Control Server URL</label>
                    <input
                      type="url"
                      placeholder="https://control.example.com"
                      value={selfHostUrl}
                      onChange={(e) => setSelfHostUrl(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        background: 'rgba(0,0,0,0.2)',
                        border: '1px solid #3f3f46',
                        borderRadius: 6,
                        color: '#fff',
                        fontSize: 13
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, color: '#a1a1aa', marginBottom: 4 }}>One-Time Pairing Code</label>
                    <input
                      type="text"
                      placeholder="ABCD-EFGH-JKMN"
                      value={selfHostCode}
                      onChange={(e) => setSelfHostCode(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        background: 'rgba(0,0,0,0.2)',
                        border: '1px solid #3f3f46',
                        borderRadius: 6,
                        color: '#fff',
                        fontSize: 13
                      }}
                    />
                  </div>
                </div>
                <div>
                  <button
                    type="button"
                    onClick={() => void handleSelfHostEnroll()}
                    disabled={enrolling}
                    style={{
                      padding: '8px 16px',
                      background: '#3b82f6',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    {enrolling ? 'Enrolling…' : 'Enroll Machine'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pending Approval Modal / Card */}
      {pendingApproval && (
        <div style={{
          padding: 20,
          background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(37, 99, 235, 0.05))',
          borderRadius: 12,
          border: '1px solid rgba(59, 130, 246, 0.4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 16
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Smartphone size={20} color="#60a5fa" />
            <div>
              <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#93c5fd' }}>
                Mobile Device Pairing Request
              </h4>
              <p style={{ margin: 0, fontSize: 12, color: '#bfdbfe' }}>
                A mobile client scanned the QR code and is requesting control access.
              </p>
            </div>
          </div>

          <div style={{
            background: 'rgba(0, 0, 0, 0.3)',
            padding: 14,
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: 13
          }}>
            <div>
              <span style={{ color: '#94a3b8' }}>Device: </span>
              <strong style={{ color: '#fff' }}>{pendingApproval.mobileDeviceName || 'Mobile Client'}</strong>
            </div>
            <div>
              <span style={{ color: '#94a3b8' }}>Fingerprint: </span>
              <code style={{ fontSize: 12, color: '#38bdf8' }}>{pendingApproval.fingerprint}</code>
            </div>
            <div>
              <span style={{ color: '#94a3b8', display: 'block', marginBottom: 6 }}>Requested Scopes:</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ALL_REMOTE_SCOPES.map((scope) => {
                  const active = approvedScopes.has(scope)
                  return (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => toggleScope(scope)}
                      style={{
                        padding: '4px 10px',
                        fontSize: 12,
                        borderRadius: 6,
                        border: active ? '1px solid #3b82f6' : '1px solid #3f3f46',
                        background: active ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                        color: active ? '#93c5fd' : '#71717a',
                        cursor: 'pointer'
                      }}
                    >
                      {scope}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => void handleReject()}
              style={{
                padding: '8px 16px',
                background: 'rgba(239, 68, 68, 0.15)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => void handleApprove()}
              style={{
                padding: '8px 18px',
                background: '#22c55e',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Approve Pairing
            </button>
          </div>
        </div>
      )}

      {/* QR Pairing Flow */}
      <div className="settings-card" style={{
        padding: 20,
        background: 'var(--card-bg, #18181b)',
        borderRadius: 12,
        border: '1px solid var(--border-color, #27272a)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Smartphone size={18} color="#a1a1aa" />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Mobile Device Pairing</h3>
          </div>
          {!activePairing && (
            <button
              type="button"
              onClick={() => void handleStartPairing()}
              style={{
                padding: '7px 14px',
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6
              }}
            >
              <QrCode size={15} />
              Pair Mobile Device
            </button>
          )}
        </div>

        <p style={{ fontSize: 13, color: '#a1a1aa', margin: '0 0 16px 0' }}>
          Scan a one-time QR v2 code with the Mousse Mobile app to establish an authenticated end-to-end encrypted session.
        </p>

        {activePairing && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            padding: 24,
            background: 'rgba(0, 0, 0, 0.25)',
            borderRadius: 10,
            border: '1px solid #27272a',
            gap: 16
          }}>
            <div style={{
              width: 220,
              height: 220,
              padding: 10,
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            dangerouslySetInnerHTML={{ __html: qrSvg || '<p style="color:#000">Generating QR…</p>' }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#e4e4e7', fontSize: 13 }}>
              <Clock size={15} color="#f59e0b" />
              <span>Expires in <strong>{Math.floor(remainingSecs / 60)}:{(remainingSecs % 60).toString().padStart(2, '0')}</strong></span>
            </div>

            <p style={{ fontSize: 12, color: '#71717a', maxWidth: 360, textAlign: 'center', margin: 0 }}>
              Open Mousse on your phone, select <strong>Scan QR</strong>, and point camera here. After scanning, you will be asked to confirm permissions on this screen.
            </p>

            <button
              type="button"
              className="settings-btn-secondary"
              onClick={() => setActivePairing(null)}
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              Cancel Pairing
            </button>
          </div>
        )}
      </div>

      {/* Paired Devices List */}
      <div className="settings-card" style={{
        padding: 20,
        background: 'var(--card-bg, #18181b)',
        borderRadius: 12,
        border: '1px solid var(--border-color, #27272a)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Shield size={18} color="#a1a1aa" />
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Paired Devices ({pairings.length})</h3>
          </div>
          <button
            type="button"
            className="settings-btn-secondary"
            onClick={() => void loadData()}
            style={{ padding: '4px 10px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        {pairings.length === 0 ? (
          <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>No mobile devices currently paired.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pairings.map((grant) => (
              <div
                key={grant.pairingId}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 12,
                  background: 'rgba(255, 255, 255, 0.02)',
                  borderRadius: 8,
                  border: '1px solid #27272a'
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: '#f4f4f5' }}>
                      {grant.mobileDeviceName || 'Mobile Client'}
                    </span>
                    <span style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      background: 'rgba(59, 130, 246, 0.15)',
                      color: '#60a5fa',
                      borderRadius: 4
                    }}>
                      {(grant.fingerprint || grant.mobileDeviceId).slice(0, 16)}…
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    {grant.grantedScopes.map((sc) => (
                      <span
                        key={sc}
                        style={{
                          fontSize: 10,
                          padding: '1px 6px',
                          background: 'rgba(255, 255, 255, 0.05)',
                          color: '#a1a1aa',
                          borderRadius: 4
                        }}
                      >
                        {sc}
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#52525b', marginTop: 4 }}>
                    Paired on {new Date(grant.createdAt).toLocaleDateString()} at {new Date(grant.createdAt).toLocaleTimeString()}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleRevoke(grant.pairingId, grant.mobileDeviceName)}
                  style={{
                    padding: '6px 12px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    color: '#f87171',
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                >
                  <Trash2 size={13} />
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
