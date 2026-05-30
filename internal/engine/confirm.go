package engine

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// ConfirmDestructive 危险操作二次确认。
//   - assumeYes 为 true 时跳过交互直接放行 (对应 --yes 标志)
//   - 非交互式终端 (无 TTY) 一律拒绝，避免脚本/cron 误触发破坏性操作
//   - 交互式下要求用户精确键入 target 名或输入 "yes" 才放行
func ConfirmDestructive(action, target string, assumeYes bool) bool {
	if assumeYes {
		return true
	}

	// 非交互式终端拒绝执行
	fi, err := os.Stdin.Stat()
	if err != nil || (fi.Mode()&os.ModeCharDevice) == 0 {
		fmt.Fprintf(os.Stderr, "[!] Refusing destructive action %q on %q in non-interactive mode (pass --yes to confirm)\n", action, target)
		return false
	}

	fmt.Printf("\n⚠️  About to %s: %s\n", action, target)
	fmt.Printf("This is destructive. Type the target name (%s) or 'yes' to confirm: ", target)

	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	input = strings.TrimSpace(input)

	return input == target || strings.EqualFold(input, "yes")
}
