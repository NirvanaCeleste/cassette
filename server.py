from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
ThreadingHTTPServer(('0.0.0.0', 8823), SimpleHTTPRequestHandler).serve_forever()
