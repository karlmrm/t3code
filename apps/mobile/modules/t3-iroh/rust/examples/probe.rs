//! cargo run --example probe -- <key-path> <ticket> [relay-url relay-token]
use std::io::{Read, Write};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let relay = args.get(3).map(|url| t3_iroh::RelaySettings { url: url.clone(), token: args.get(4).cloned() });
    let id = t3_iroh::start(&args[1], relay)?;
    println!("id {id}");
    println!("sig {}", t3_iroh::sign("hello")?);
    let started = std::time::Instant::now();
    let port = t3_iroh::forward(&args[2])?;
    for round in 0..3 {
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port))?;
        socket.write_all(b"GET /.well-known/t3/environment HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")?;
        let mut body = String::new();
        socket.read_to_string(&mut body)?;
        println!("round {round} after {:?}: {}", started.elapsed(), body.lines().last().unwrap_or("").chars().take(120).collect::<String>());
    }
    std::thread::sleep(std::time::Duration::from_secs(4));
    println!("{}", t3_iroh::status());
    Ok(())
}
