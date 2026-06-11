package tools

type SSHProvider interface {
	Execute(address, sshKey, cmd string) (string, error)
}