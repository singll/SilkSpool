package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"time"
)

// JobState 是 job 生命周期状态。
type JobState string

const (
	JobQueued    JobState = "queued"
	JobRunning   JobState = "running"
	JobSucceeded JobState = "succeeded"
	JobFailed    JobState = "failed"
)

// Job 是异步 action 的执行记录。
type Job struct {
	ID             string        `json:"id"`
	Action         string        `json:"action"`
	Target         Target        `json:"target"`
	Options        ActionOptions `json:"options,omitempty"`
	State          JobState      `json:"state"`
	IdempotencyKey string        `json:"idempotency_key,omitempty"`
	Actor          string        `json:"actor,omitempty"`
	StartedAt      string        `json:"started_at,omitempty"`
	FinishedAt     string        `json:"finished_at,omitempty"`
	Result         interface{}   `json:"result,omitempty"`
	Error          string        `json:"error,omitempty"`
}

// JobManager 负责排队、幂等与 per-host 串行。
type JobManager struct {
	mu        sync.Mutex
	jobs      map[string]*Job
	idem      map[string]string
	hostLocks map[string]*sync.Mutex
	runner    ActionRunner
	audit     *AuditLogger
	now       func() time.Time
}

// NewJobManager 创建 job 管理器。
func NewJobManager(runner ActionRunner, audit *AuditLogger) *JobManager {
	if audit == nil {
		audit = NewAuditLogger(nil)
	}
	return &JobManager{
		jobs:      map[string]*Job{},
		idem:      map[string]string{},
		hostLocks: map[string]*sync.Mutex{},
		runner:    runner,
		audit:     audit,
		now:       time.Now,
	}
}

// Submit 创建或复用 job。reused 为 true 表示 idempotency_key 命中了未完成 job。
func (m *JobManager) Submit(request ActionRequest, actor string) (*Job, bool) {
	m.mu.Lock()
	if request.IdempotencyKey != "" {
		if id, ok := m.idem[request.IdempotencyKey]; ok {
			if existing, ok := m.jobs[id]; ok && (existing.State == JobQueued || existing.State == JobRunning) {
				clone := *existing
				m.mu.Unlock()
				return &clone, true
			}
		}
	}

	id := newJobID()
	job := &Job{
		ID:             id,
		Action:         request.Action,
		Target:         request.Target,
		Options:        request.Options,
		State:          JobQueued,
		IdempotencyKey: request.IdempotencyKey,
		Actor:          actor,
	}
	m.jobs[id] = job
	if request.IdempotencyKey != "" {
		m.idem[request.IdempotencyKey] = id
	}
	clone := *job
	m.mu.Unlock()

	go m.run(id)
	return &clone, false
}

// Get 返回 job 的副本。
func (m *JobManager) Get(id string) (*Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[id]
	if !ok {
		return nil, false
	}
	clone := *job
	return &clone, true
}

func (m *JobManager) run(id string) {
	m.mu.Lock()
	job, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	job.State = JobRunning
	job.StartedAt = m.now().UTC().Format(time.RFC3339Nano)
	action := job.Action
	target := job.Target
	options := job.Options
	key := job.IdempotencyKey
	actor := job.Actor
	m.mu.Unlock()

	hostLock := m.hostLock(target.Host)
	hostLock.Lock()
	var (
		result interface{}
		err    error
	)
	if m.runner == nil {
		err = fmt.Errorf("no action runner configured")
	} else {
		result, err = m.runner.Run(context.Background(), action, target, options)
	}
	hostLock.Unlock()

	m.mu.Lock()
	job.FinishedAt = m.now().UTC().Format(time.RFC3339Nano)
	if err != nil {
		job.State = JobFailed
		job.Error = err.Error()
	} else {
		job.State = JobSucceeded
		job.Result = result
	}
	state := job.State
	jobErr := job.Error
	if job.IdempotencyKey != "" && job.State == JobFailed {
		delete(m.idem, job.IdempotencyKey)
	}
	if job.IdempotencyKey != "" && job.State == JobSucceeded {
		delete(m.idem, job.IdempotencyKey)
	}
	m.mu.Unlock()

	m.audit.Log(AuditEntry{
		Time:           m.now().UTC().Format(time.RFC3339Nano),
		Actor:          actor,
		Action:         action,
		Target:         target,
		IdempotencyKey: key,
		JobID:          id,
		State:          string(state),
		Error:          jobErr,
	})
}

func (m *JobManager) hostLock(host string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	if lock, ok := m.hostLocks[host]; ok {
		return lock
	}
	lock := &sync.Mutex{}
	m.hostLocks[host] = lock
	return lock
}

func newJobID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("job_%d", time.Now().UnixNano())
	}
	return "job_" + hex.EncodeToString(buf[:])
}

// AuditEntry 是一条本地审计记录。
type AuditEntry struct {
	Time           string `json:"ts"`
	Actor          string `json:"actor"`
	Action         string `json:"action"`
	Target         Target `json:"target"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
	JobID          string `json:"job_id"`
	State          string `json:"state"`
	Error          string `json:"error,omitempty"`
}

// AuditLogger 以 JSON Lines 写本地审计日志。
type AuditLogger struct {
	mu sync.Mutex
	w  io.Writer
}

// NewAuditLogger 创建审计日志；w 为 nil 时丢弃。
func NewAuditLogger(w io.Writer) *AuditLogger {
	return &AuditLogger{w: w}
}

// Log 写入一条审计记录。
func (l *AuditLogger) Log(entry AuditEntry) {
	if l == nil || l.w == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_ = json.NewEncoder(l.w).Encode(entry)
}
