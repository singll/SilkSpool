package utils

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/fatih/color"
)

// LogLevel 日志级别
type LogLevel int

const (
	LogLevelInfo LogLevel = iota
	LogLevelWarn
	LogLevelError
	LogLevelSuccess
	LogLevelStep
)

// Logger 日志记录器
type Logger struct {
	writer   io.Writer
	minLevel LogLevel
}

// NewLogger 创建一个新的日志记录器
func NewLogger() *Logger {
	return &Logger{
		writer:   os.Stdout,
		minLevel: LogLevelInfo,
	}
}

// SetOutput 设置输出目标
func (l *Logger) SetOutput(w io.Writer) {
	l.writer = w
}

// Info 输出信息日志
func (l *Logger) Info(format string, args ...interface{}) {
	l.log(LogLevelInfo, format, args...)
}

// Warn 输出警告日志
func (l *Logger) Warn(format string, args ...interface{}) {
	l.log(LogLevelWarn, format, args...)
}

// Error 输出错误日志
func (l *Logger) Error(format string, args ...interface{}) {
	l.log(LogLevelError, format, args...)
}

// Success 输出成功日志
func (l *Logger) Success(format string, args ...interface{}) {
	l.log(LogLevelSuccess, format, args...)
}

// Step 输出步骤日志
func (l *Logger) Step(format string, args ...interface{}) {
	l.log(LogLevelStep, format, args...)
}

// Fatal 输出错误日志并退出
func (l *Logger) Fatal(format string, args ...interface{}) {
	l.log(LogLevelError, format, args...)
	os.Exit(1)
}

func (l *Logger) log(level LogLevel, format string, args ...interface{}) {
	if level < l.minLevel {
		return
	}

	msg := fmt.Sprintf(format, args...)
	timestamp := ""

	var prefix string
	var prefixColor *color.Color

	switch level {
	case LogLevelStep:
		prefix = ">>> "
		prefixColor = color.New(color.FgBlue)
		timestamp = getTimestamp()
	case LogLevelInfo:
		prefix = "[INFO] "
		prefixColor = color.New(color.FgWhite)
	case LogLevelWarn:
		prefix = "[WARN] "
		prefixColor = color.New(color.FgYellow)
	case LogLevelError:
		prefix = "[ERR]  "
		prefixColor = color.New(color.FgRed)
	case LogLevelSuccess:
		prefix = "[OK]   "
		prefixColor = color.New(color.FgGreen)
	}

	// 兼容旧脚本格式: [INFO] / [OK] / [ERR]
	// 如果设置了 NO_COLOR 或不是终端，则使用纯文本
	if isTTY() {
		fmt.Fprintf(l.writer, "%s%s%s\n", prefixColor.Sprint(prefix), timestamp, msg)
	} else {
		// 纯文本模式，移除颜色
		cleanPrefix := strings.TrimSpace(prefix)
		fmt.Fprintf(l.writer, "%s %s%s\n", cleanPrefix, timestamp, msg)
	}
}

// getTimestamp 返回时间戳 (带空格前缀以对齐)
func getTimestamp() string {
	return time.Now().Format("2006-01-02 15:04:05 ") + " "
}

// isTTY 检查输出是否为终端
func isTTY() bool {
	return color.NoColor == false
}

// DefaultLogger 默认日志记录器
var DefaultLogger = NewLogger()

// 全局便捷函数
func Info(format string, args ...interface{})   { DefaultLogger.Info(format, args...) }
func Warn(format string, args ...interface{})   { DefaultLogger.Warn(format, args...) }
func Error(format string, args ...interface{})  { DefaultLogger.Error(format, args...) }
func Success(format string, args ...interface{}) { DefaultLogger.Success(format, args...) }
func Step(format string, args ...interface{})   { DefaultLogger.Step(format, args...) }
func Fatal(format string, args ...interface{})  { DefaultLogger.Fatal(format, args...) }
