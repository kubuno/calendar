mod instance;
mod settings;
pub use instance::{
    directory_knows_email, fetch as fetch_instance, FreeBusyVisibility, InstanceConfig,
    PublicDetail,
};
pub use settings::*;
