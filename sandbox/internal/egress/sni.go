// Copyright 2026 Rob Macrae. All rights reserved.
// SPDX-License-Identifier: LicenseRef-Proprietary

// REVISION: egress-sni-v1-tls-clienthello-parser

package egress

import (
	"encoding/binary"
	"log"
	"time"
)

const sniRevision = "egress-sni-v1-tls-clienthello-parser"

func init() {
	log.Printf("[egress-sni] REVISION: %s loaded at %s", sniRevision, time.Now().Format(time.RFC3339))
}

// extractSNI parses a TLS ClientHello record and returns the ServerName extension value.
// buf must start with byte 0x16 (TLS handshake record). Returns empty string if SNI is
// absent or data is malformed/truncated.
func extractSNI(buf []byte) string {
	// TLS record: ContentType(1) + Version(2) + Length(2) = 5 bytes header
	// Handshake:  Type(1) + Length(3) = 4 bytes
	// ClientHello body starts at offset 9.
	// Minimum to reach session_id_len: 9 + 2 (version) + 32 (random) = 43 bytes
	if len(buf) < 44 {
		return ""
	}
	if buf[0] != 0x16 { // ContentType: Handshake
		return ""
	}
	if buf[5] != 0x01 { // HandshakeType: ClientHello
		return ""
	}

	offset := 9 // start of ClientHello body

	// client_version (2)
	offset += 2
	// random (32)
	offset += 32
	// session_id_length (1) + session_id
	if offset >= len(buf) {
		return ""
	}
	sessionIDLen := int(buf[offset])
	offset++
	offset += sessionIDLen
	// cipher_suites_length (2) + cipher_suites
	if offset+2 > len(buf) {
		return ""
	}
	cipherSuitesLen := int(binary.BigEndian.Uint16(buf[offset:]))
	offset += 2 + cipherSuitesLen
	// compression_methods_length (1) + compression_methods
	if offset+1 > len(buf) {
		return ""
	}
	compressionLen := int(buf[offset])
	offset += 1 + compressionLen
	// extensions_length (2)
	if offset+2 > len(buf) {
		return ""
	}
	extLen := int(binary.BigEndian.Uint16(buf[offset:]))
	offset += 2
	extEnd := offset + extLen
	if extEnd > len(buf) {
		extEnd = len(buf)
	}

	// Walk extensions looking for SNI (type 0x0000)
	for offset+4 <= extEnd {
		extType := binary.BigEndian.Uint16(buf[offset:])
		extDataLen := int(binary.BigEndian.Uint16(buf[offset+2:]))
		offset += 4
		if offset+extDataLen > extEnd {
			break
		}
		if extType == 0x0000 { // server_name extension
			// server_name_list_length(2) + name_type(1) + name_length(2) + name
			if extDataLen < 5 {
				return ""
			}
			nameType := buf[offset+2]
			if nameType != 0 { // 0 = host_name
				return ""
			}
			nameLen := int(binary.BigEndian.Uint16(buf[offset+3:]))
			if offset+5+nameLen > extEnd {
				return ""
			}
			return string(buf[offset+5 : offset+5+nameLen])
		}
		offset += extDataLen
	}
	return ""
}
